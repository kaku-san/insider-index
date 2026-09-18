import { PublicKey, VersionedTransaction, type AccountInfo, type AddressLookupTableAccount } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, unpackAccount, unpackMint, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { VaultLayout } from "@symmetry-hq/sdk/dist/layouts/basket.js";
import { RebalanceAction, RebalanceType, RebalanceIntentLayout } from "@symmetry-hq/sdk/dist/layouts/intents/rebalanceIntent.js";
import { computeRebalanceIntentBountyAmount, getSwapPairs } from "@symmetry-hq/sdk/dist/states/intents/rebalanceIntent.js";
import { getVaultFeesPda } from "@symmetry-hq/sdk/dist/instructions/pda.js";
import type { TxPayloadBatchSequence, Vault } from "@symmetry-hq/sdk";
import { randomUUID } from "node:crypto";
import { isolateCycleBounty } from "./cycle-bounty.ts";
import { address, hashObject, rawAmount, sdkRawAmount, sha256 } from "./amounts.ts";
import { assertCycleExecutionAuthorized, cyclePolicyHash, type CyclePolicy } from "./cycle-policy.ts";
import { assertMintEffects, creditSaleAmount, fractionRaw } from "./cycle-accounting.ts";
import { observeCycle, cycleAta, type CycleChain } from "./cycle-observer.ts";
import { buildCycleRoute, assertCycleRouteInstruction, type PoolMetadata } from "./cycle-routes.ts";
import { buildCycleFillWire, cycleInstructions, encodeCycleWire, type CycleWire } from "./cycle-wire.ts";
import { MAINNET_USDC, NATIVE_DEFAULT_BINDINGS } from "./native-defaults.ts";
import { legBindings } from "./keeper-tick.ts";
import { completeKeepTokens, type NativeVaultBuilders } from "./symmetry-adapter.ts";
import { evaluateRebalanceDrift } from "./rebalance-eligibility.ts";
import { WSOL_MINT } from "./raydium-oracles.ts";
import type { PersistedVaultDefinition } from "./vault-definition-store.ts";
import type { CycleAction, CyclePending, CycleState } from "./cycle-store.ts";

export interface CyclePreparation { action: CycleAction | "wait" | "holding" | "complete"; reason: string; pending?: CyclePending; }
const pk = (s: string) => new PublicKey(address(s));
function first(payload: TxPayloadBatchSequence): TxPayloadBatchSequence {
  const tx = payload.batches.flatMap(b => b.transactions)[0]; if (!tx) throw new Error("CYCLE_NO_NATIVE_TRANSACTION");
  return { batches: [{ transactions: [tx] }] };
}
function localBalance(chain: CycleChain, accounts: Map<string, AccountInfo<Buffer> | null>, owner: string, mint: string) {
  const binding = chain.mintBindings.find(b => b.mint === mint); if (!binding) throw new Error("CYCLE_UNKNOWN_MINT");
  const key = cycleAta(owner, binding), account = accounts.get(key);
  return account ? unpackAccount(pk(key), account, pk(binding.tokenProgram)).amount : 0n;
}

/** Read-only both-direction prerequisite, not a guarantee of market prices at a later redemption. */
export async function preflightCycleRoutes(native: NativeVaultBuilders, record: PersistedVaultDefinition, policy: CyclePolicy, metadata?: PoolMetadata) {
  let minimum = 0n;
  const routes = [];
  for (const leg of record.vaultLegs) {
    const input = rawAmount(policy.limits.depositUsdcRaw) * BigInt(leg.targetWeightBps) / 10000n;
    if (input === 0n) throw new Error("CYCLE_AMOUNT_CANNOT_REPRESENT_EVERY_LEG");
    const buy = await buildCycleRoute({ connection: native.connection, leg, owner: policy.keeper, inputMint: MAINNET_USDC, outputMint: leg.mint, amountInRaw: input.toString(), slippageBps: policy.limits.swapSlippageBps, maxAgeMs: policy.limits.quoteMaxAgeMs, metadata });
    const exit = await buildCycleRoute({ connection: native.connection, leg, owner: policy.owner, inputMint: leg.mint, outputMint: MAINNET_USDC, amountInRaw: buy.minOutRaw, slippageBps: policy.limits.swapSlippageBps, maxAgeMs: policy.limits.quoteMaxAgeMs, metadata });
    minimum += rawAmount(exit.minOutRaw); routes.push(buy, exit);
  }
  if (routes.some(r => r.expiresAt <= Date.now()) || minimum < rawAmount(policy.limits.minExitUsdcRaw)) throw new Error("CYCLE_EXIT_PREREQUISITE_NOT_MET");
  return { quotedExitMinimumUsdcRaw: minimum.toString(), expiresAt: Math.min(...routes.map(r => r.expiresAt)) };
}

/** Internal native execution planner. Every returned wire is unsigned and actually simulated.
 * User and keeper actions remain separate; no signer/sender or key-file loader is imported here. */
export async function prepareCycleStep(input: {
  native: NativeVaultBuilders; record: PersistedVaultDefinition; policy: CyclePolicy; state: CycleState;
  actor: "owner" | "keeper"; request?: "next" | "withdraw" | "recover"; metadata?: PoolMetadata;
}): Promise<CyclePreparation> {
  const { native, record, policy, state } = input;
  const recovering = input.request === "recover" || input.request === "withdraw" || state.phase === "recovering" || state.phase === "exiting";
  if (input.request === "withdraw" && !["holding", "exiting"].includes(state.phase)) throw new Error("CYCLE_WITHDRAW_REQUIRES_HELD_SHARES");
  if (input.request === "recover" && input.actor !== "owner") throw new Error("CYCLE_OWNER_RECOVERY_AUTHORITY_REQUIRED");
  assertCycleExecutionAuthorized(policy, record, recovering || input.request === "withdraw" ? "recovery" : "deposit");
  if (state.policyHash !== cyclePolicyHash(policy) || state.definitionHash !== policy.definitionHash || state.operationId !== policy.operationId || state.vault !== policy.vault || state.owner !== policy.owner || state.indexId !== policy.indexId) throw new Error("CYCLE_OPERATION_SCOPE");
  if (state.recoveryRequired && !recovering) throw new Error(`CYCLE_RECOVERY_REQUIRED:${state.recoveryRequired}`);
  if (state.pending) return { action: "wait", reason: "Resolve the existing draft/signature; never prepare a duplicate contribution or burn." };
  if (state.phase === "complete") return { action: "complete", reason: "This operation is complete. Native token accounts, not this journal, remain ownership truth." };
  const chain = await observeCycle(native, record, policy, recovering || input.request === "withdraw" ? "recovery" : "strict"), i = chain.intent?.chain_data;
  if (state.phase === "new" && !i && !recovering) {
    const hasBacking = chain.vault.composition.slice(0, chain.vault.numTokens).some(t => !t.amount.isZero());
    if ((chain.shareSupply === 0n) === hasBacking) throw new Error("CYCLE_UNOWNED_OR_EMPTY_NATIVE_BACKING");
    if (chain.shareSupply === 0n) {
      const start = fractionRaw(chain.vault.settings.startPrice);
      // Necessary representability check, not an atomic min-share promise. Native's $1 USDC
      // basis and price-per-RAW-share are used without changing the installed start price.
      if (start <= 0n || rawAmount(policy.limits.depositUsdcRaw) * (1n << 64n) / (1000000n * start) < rawAmount(policy.limits.minNetSharesRaw)) throw new Error("CYCLE_AMOUNT_CANNOT_REPRESENT_MINIMUM_SHARES");
    }
  }
  const payer = input.actor === "owner" ? policy.owner : policy.keeper;
  const spent = rawAmount(input.actor === "owner" ? state.ownerSolDebitLamports : state.keeperSolDebitLamports);
  const budget = rawAmount(input.actor === "owner" ? policy.limits.maxOwnerSolDebitLamports : policy.limits.maxKeeperSolDebitLamports);
  if (spent >= budget) throw new Error("CYCLE_SOL_BUDGET_EXHAUSTED");
  const remaining = (budget - spent).toString();
  const wireOptions = { payer, computeUnits: policy.limits.maxComputeUnits, microLamports: policy.limits.maxMicroLamports, maxPriorityFeeLamports: remaining };
  const stepId = randomUUID();
  let bounty: CyclePending["bounty"];
  let action: CycleAction, payload: TxPayloadBatchSequence | undefined, wire: CycleWire | undefined;
  let exactInputRaw: string | undefined, inputMint: string | undefined, minOutputRaw: string | undefined;
  let deadline = Math.min(policy.expiresAt, Date.now() + policy.limits.quoteMaxAgeMs);
  const setup = chain.mintBindings.filter(m => m.mint !== policy.shareMint && !chain.accounts.get(cycleAta(policy.keeper, m)));
  let surplusPricesQ: Record<string, string> | undefined;
  const ownerOnly = () => { if (input.actor !== "owner") throw new Error("CYCLE_OWNER_SIGNATURE_REQUIRED"); };
  const keeperOnly = () => { if (input.actor !== "keeper") throw new Error("CYCLE_SEPARATE_KEEPER_REQUIRED"); };
  if (recovering && i && i.rebalanceType === RebalanceType.Deposit && state.mintedSharesRaw === "0") {
    ownerOnly(); action = "cancel"; payload = await native.sdk.cancelRebalanceIntentTx({ keeper: payer, rebalance_intent: chain.intentAddress });
  } else if (recovering && state.phase === "new" && !i) {
    return { action: "complete", reason: "No native generation or invested assets; reconcile setup costs only." };
  } else if (!i && state.phase === "new" && input.actor === "keeper") {
    if (!setup.length) return { action: "wait", reason: "Keeper token accounts are ready; only the owner may create/contribute." };
    action = "setup-keeper";
    const latest = await native.connection.getLatestBlockhash("confirmed");
    wire = encodeCycleWire({ ...wireOptions, blockhash: latest.blockhash, instructions: setup.slice(0, 5).map(m => createAssociatedTokenAccountIdempotentInstruction(pk(payer), pk(cycleAta(payer, m)), pk(payer), pk(m.mint), pk(m.tokenProgram))), tables: [] });
  } else if (!i && state.phase === "new") {
    ownerOnly();
    if (setup.length) throw new Error("CYCLE_KEEPER_SETUP_REQUIRED_BEFORE_DEPOSIT");
    const exits = await preflightCycleRoutes(native, record, policy, input.metadata); deadline = Math.min(deadline, exits.expiresAt);
    action = "create"; payload = first(await native.sdk.buyVaultTx({ buyer: payer, vault_mint: policy.shareMint, contributions: [{ mint: MAINNET_USDC, amount: sdkRawAmount(policy.limits.depositUsdcRaw) }], rebalance_slippage_bps: policy.limits.rebalanceSlippageBps, per_trade_rebalance_slippage_bps: policy.limits.perTradeSlippageBps }));
  } else if (i?.rebalanceType === RebalanceType.Deposit && i.currentAction === RebalanceAction.DepositTokens) {
    ownerOnly();
    if (!state.depositGenerationSignature) throw new Error("CYCLE_UNBOUND_NATIVE_GENERATION");
    const credited = i.tokens.find(t => t.mint.toBase58() === MAINNET_USDC)?.amount.toString() ?? "0";
    if (state.contributedUsdcRaw === "0") {
      if (credited !== "0") throw new Error("CYCLE_EXTERNAL_CONTRIBUTION_REQUIRES_RECEIPT");
      const exits = await preflightCycleRoutes(native, record, policy, input.metadata); deadline = Math.min(deadline, exits.expiresAt);
      action = "contribute"; inputMint = MAINNET_USDC; exactInputRaw = policy.limits.depositUsdcRaw;
      if (chain.balance(payer, MAINNET_USDC) < rawAmount(exactInputRaw)) throw new Error("CYCLE_INSUFFICIENT_USDC");
      payload = await native.sdk.depositTokensTx({ buyer: payer, rebalance_intent: chain.intentAddress, contributions: [{ mint: MAINNET_USDC, amount: sdkRawAmount(exactInputRaw) }] });
    } else {
      if (credited !== state.contributedUsdcRaw) throw new Error("CYCLE_CONTRIBUTION_RECONCILIATION");
      action = "lock"; payload = await native.sdk.lockDepositsTx({ buyer: payer, vault_mint: policy.shareMint });
    }
  } else if (i?.rebalanceType === RebalanceType.Deposit && i.currentAction === RebalanceAction.UpdatePrices) {
    keeperOnly();
    if (chain.timestamp < Number(i.executionStartTime.toString())) return { action: "wait", reason: "Native execution start time has not arrived." };
    const priced = await native.priceUpdateFromVault(chain.vault, payer, chain.intentAddress, [...legBindings(record.vaultLegs), ...NATIVE_DEFAULT_BINDINGS]);
    const index = priced.plan.tokenIndices.findIndex(indices => indices.some(n => i.priceUpdateTasks[n]?.completedTime.isZero()));
    if (index < 0) throw new Error("CYCLE_PRICE_TASK_RECONCILIATION");
    action = "prices"; payload = { batches: [{ transactions: [priced.payload.batches.flatMap(b => b.transactions)[index]] }] };
  } else if (i?.rebalanceType === RebalanceType.Deposit && i.currentAction === RebalanceAction.Auction) {
    keeperOnly();
    if (chain.timestamp > Number(i.auctions[2].endTime.toString())) {
      for (const leg of record.vaultLegs) if (!i.tokens.some(t => t.mint.toBase58() === leg.mint && !t.amount.isZero())) throw new Error("CYCLE_INCOMPLETE_BOOK_RECOVER_DO_NOT_MINT");
      if (i.tokens.some(t => t.mint.toBase58() === WSOL_MINT && !t.amount.isZero())) throw new Error("CYCLE_ACCOUNTED_SUPPORT_REQUIRES_RECONCILIATION");
      const drift = evaluateRebalanceDrift({ bountyMint: WSOL_MINT, rebalanceActivationThresholdRelBps: 0, rebalanceActivationThresholdAbsBps: policy.limits.maxSettlementDriftBps, tokens: chain.vault.composition.slice(0, chain.vault.numTokens).map(t => {
        const contribution = i.tokens.find(c => c.mint.equals(t.mint)), priceQuote = contribution ? fractionRaw(contribution.price.price) : null;
        return { mint: t.mint.toBase58(), weight: t.weight, amountRaw: BigInt(t.amount.toString()) + BigInt(contribution?.amount.toString() ?? "0"), priceQuote, validated: priceQuote !== null && priceQuote > 0n };
      }) }, { nativeThresholdInflation: false });
      if (drift.required !== false || drift.reason !== "on-target") throw new Error(`CYCLE_INCOMPLETE_BOOK_RECOVER_DO_NOT_MINT:${drift.reason}`);
      action = "mint"; payload = await native.sdk.mintTx({ keeper: payer, rebalance_intent: chain.intentAddress });
    } else {
      if (Math.abs(Date.now() / 1000 - chain.timestamp) > 2) return { action: "wait", reason: "SDK and observed chain clocks differ; do not force an auction fill." };
      const missing = new Set(record.vaultLegs.filter(l => !i.tokens.some(t => t.mint.toBase58() === l.mint && !t.amount.isZero())).map(l => l.mint));
      const candidates = getSwapPairs(i, chain.vault).filter(p => p.outMint === MAINNET_USDC && (!missing.size || missing.has(p.inMint)));
      const fills = [];
      let available = BigInt(i.tokens.find(t => t.mint.toBase58() === MAINNET_USDC)?.amount.toString() ?? "0");
      for (const pair of candidates) {
        if (!Number.isSafeInteger(pair.inAmount) || !Number.isSafeInteger(pair.outAmount) || BigInt(pair.outAmount) > available) continue;
        const leg = record.vaultLegs.find(l => l.mint === pair.inMint); if (!leg) throw new Error("CYCLE_UNRECOGNIZED_NATIVE_TARGET");
        try {
          const route = await buildCycleRoute({ connection: native.connection, leg, owner: payer, inputMint: MAINNET_USDC, outputMint: leg.mint, amountInRaw: String(pair.outAmount), minimumOutRaw: String(pair.inAmount), slippageBps: policy.limits.swapSlippageBps, maxAgeMs: policy.limits.quoteMaxAgeMs, metadata: input.metadata });
          fills.push({ route, maxRepaymentRaw: String(pair.inAmount) }); available -= BigInt(pair.outAmount); deadline = Math.min(deadline, route.expiresAt);
          if (fills.length === 2) break;
        } catch (error) { if (error instanceof Error && error.message === "CYCLE_ROUTE_MINIMUM_UNSATISFIABLE") continue; throw error; }
      }
      if (!fills.length) return { action: "wait", reason: "No actual DEX route covers native repayment inside the existing slippage/time limits." };
      action = "fill"; wire = await buildCycleFillWire({ native, keeper: payer, vault: policy.vault, intent: chain.intentAddress, fills, ...wireOptions });
    }
  } else if (i && (i.rebalanceType === RebalanceType.Withdraw || state.mintedSharesRaw !== "0" || recovering)) {
    const claims = i.tokens.filter(t => !t.amount.isZero());
    if (claims.length) { ownerOnly(); action = "claim"; payload = first(await native.sdk.redeemTokensTx({ keeper: payer, rebalance_intent: chain.intentAddress })); }
    else {
      if (!recovering) keeperOnly(); // Recovery/closure never depends on the keeper remaining online.
      action = "cleanup"; payload = first(await native.sdk.claimBountyTx({ keeper: payer, rebalance_intent: chain.intentAddress }));
    }
  } else if (!i && (state.phase === "exiting" || state.phase === "recovering")) {
    ownerOnly();
    const leg = record.vaultLegs.find(l => creditSaleAmount(state.credits, state, l.mint) > 0n);
    if (!leg) return { action: "complete", reason: "No remaining stock-credit sale. Reconcile native obligations and total realized USDC before completing." };
    inputMint = leg.mint; exactInputRaw = creditSaleAmount(state.credits, state, leg.mint).toString();
    if (chain.balance(policy.owner, leg.mint) < rawAmount(exactInputRaw)) throw new Error("CYCLE_CREDIT_BALANCE_MISSING");
    const last = record.vaultLegs.filter(l => creditSaleAmount(state.credits, state, l.mint) > 0n).length === 1;
    const required = rawAmount(policy.limits.minExitUsdcRaw) > rawAmount(state.recoveredUsdcRaw) ? rawAmount(policy.limits.minExitUsdcRaw) - rawAmount(state.recoveredUsdcRaw) : 0n;
    const route = await buildCycleRoute({ connection: native.connection, leg, owner: payer, inputMint: leg.mint, outputMint: MAINNET_USDC, amountInRaw: exactInputRaw, minimumOutRaw: last ? required.toString() : undefined, slippageBps: policy.limits.swapSlippageBps, maxAgeMs: policy.limits.quoteMaxAgeMs, metadata: input.metadata });
    assertCycleRouteInstruction(route, payer); action = "convert"; minOutputRaw = route.minOutRaw; deadline = Math.min(deadline, route.expiresAt);
    const latest = await native.connection.getLatestBlockhash("confirmed");
    wire = encodeCycleWire({ ...wireOptions, blockhash: latest.blockhash, instructions: [route.instruction], tables: route.lookupTables });
  } else if (!i && state.mintedSharesRaw !== "0") {
    if (input.request !== "withdraw") return { action: "holding", reason: "Native shares are held by the wallet. Withdrawal requires its own explicit signature." };
    ownerOnly();
    const amount = rawAmount(state.mintedSharesRaw) - rawAmount(state.burnedSharesRaw);
    if (amount <= 0n || chain.balance(policy.owner, policy.shareMint) < amount) throw new Error("CYCLE_NATIVE_SHARE_BALANCE");
    let minimum = 0n;
    for (const token of chain.vault.composition.slice(0, chain.vault.numTokens)) {
      const raw = BigInt(token.amount.toString()) * amount / chain.shareSupply;
      if (!raw) continue;
      if (token.mint.toBase58() === MAINNET_USDC) { minimum += raw; continue; }
      const leg = record.vaultLegs.find(l => l.mint === token.mint.toBase58());
      if (!leg) throw new Error("CYCLE_SUPPORT_EXIT_NOT_PROVED");
      const route = await buildCycleRoute({ connection: native.connection, leg, owner: payer, inputMint: leg.mint, outputMint: MAINNET_USDC, amountInRaw: raw.toString(), slippageBps: policy.limits.swapSlippageBps, maxAgeMs: policy.limits.quoteMaxAgeMs, metadata: input.metadata });
      minimum += rawAmount(route.minOutRaw); deadline = Math.min(deadline, route.expiresAt);
    }
    if (minimum + rawAmount(state.recoveredUsdcRaw) < rawAmount(policy.limits.minExitUsdcRaw)) throw new Error("CYCLE_EXIT_PREREQUISITE_NOT_MET");
    action = "withdraw"; inputMint = policy.shareMint; exactInputRaw = amount.toString();
    payload = first(await native.sdk.sellVaultTx({ seller: payer, vault_mint: policy.shareMint, withdraw_amount: sdkRawAmount(exactInputRaw), keep_tokens: completeKeepTokens(chain.vault), rebalance_slippage_bps: policy.limits.rebalanceSlippageBps, per_trade_rebalance_slippage_bps: policy.limits.perTradeSlippageBps }));
  } else return { action: "wait", reason: "Native state needs reconciliation; no inferred funding, mint, burn or refund." };

  const block = await native.connection.getLatestBlockhashAndContext("finalized"), latest = block.value;
  if (payload) {
    const decoded = await cycleInstructions(native, payload, payer);
    if (action === "create" || action === "withdraw") {
      const global = await native.sdk.fetchGlobalConfig();
      if (global.bountyMint.toBase58() !== WSOL_MINT) throw new Error("CYCLE_BOUNTY_MINT_UNSUPPORTED");
      const perTask = sdkRawAmount(global.bountyPerTask.maxBounty.toString()), divisor = sdkRawAmount(global.bountyPerPriceUpdateTaskDivisor.toString());
      const funding = computeRebalanceIntentBountyAmount(RebalanceType.Deposit, chain.vault.numTokens, sdkRawAmount(global.bountyBondAmount.toString()), perTask, Math.floor(perTask / divisor));
      if (!Number.isSafeInteger(funding) || funding < 0) throw new Error("CYCLE_BOUNTY_PRECISION");
      const maximum = rawAmount(policy.limits.maxBountyRaw) - rawAmount(state.bountyFundingRaw);
      if (maximum < 0n) throw new Error("CYCLE_BOUNTY_FUNDING_CAP");
      const isolated = await isolateCycleBounty({ connection: native.connection, owner: payer, fundingRaw: String(funding), maximumRaw: maximum.toString(), instructions: decoded.instructions });
      decoded.instructions = isolated.instructions; bounty = { account: isolated.account, restoreWsolRaw: isolated.restoreWsolRaw, fundingRaw: isolated.fundingRaw };
    }
    wire = encodeCycleWire({ ...wireOptions, blockhash: latest.blockhash, ...decoded });
  }
  if (!wire || deadline <= Date.now()) throw new Error("CYCLE_PREPARATION_EXPIRED");
  const tx = VersionedTransaction.deserialize(Buffer.from(wire.txBase64, "base64")); tx.message.recentBlockhash = latest.blockhash;
  wire = { ...wire, txBase64: Buffer.from(tx.serialize()).toString("base64"), messageHash: sha256(tx.message.serialize()), blockhash: latest.blockhash };
  const tables: AddressLookupTableAccount[] = [];
  for (const lookup of tx.message.addressTableLookups) { const t = await native.connection.getAddressLookupTable(lookup.accountKey); if (!t.value) throw new Error("CYCLE_LOOKUP_UNAVAILABLE"); tables.push(t.value); }
  const messageKeys = tx.message.getAccountKeys({ addressLookupTableAccounts: tables });
  const watch = Array.from({ length: messageKeys.length }, (_, n) => messageKeys.get(n)!);
  const pre = await native.connection.getMultipleAccountsInfoAndContext(watch, "confirmed");
  const before = new Map(chain.accounts); for (let n = 0; n < watch.length; n++) before.set(watch[n].toBase58(), pre.value[n]);
  for (const key of [policy.vault, chain.intentAddress]) {
    const a = chain.accounts.get(key), b = before.get(key);
    if ((a?.data.toString("base64") ?? null) !== (b?.data.toString("base64") ?? null)) throw new Error("CYCLE_NATIVE_STATE_CHANGED_REPREPARE");
  }
  const simulated = await native.connection.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: false, commitment: "confirmed", accounts: { encoding: "base64", addresses: watch.map(k => k.toBase58()) }, minContextSlot: pre.context.slot });
  if (simulated.value.err || !simulated.value.accounts || simulated.value.accounts.length !== watch.length) throw new Error(`CYCLE_SIMULATION_REFUSED:${JSON.stringify(simulated.value.err ?? "post-accounts missing")}:${simulated.value.logs?.slice(-8).join(" | ") ?? "no logs"}`);
  const after = new Map(before);
  for (let n = 0; n < watch.length; n++) { const a = simulated.value.accounts[n]; after.set(watch[n].toBase58(), a ? { ...a, data: Buffer.from(a.data[0], "base64"), owner: pk(a.owner) } : null); }
  const delta = (owner: string, mint: string) => localBalance(chain, after, owner, mint) - localBalance(chain, before, owner, mint);
  for (const m of chain.mintBindings) {
    const d = delta(payer, m.mint);
    if (d < 0n && !(action === "contribute" && m.mint === MAINNET_USDC && -d === rawAmount(policy.limits.depositUsdcRaw)) && !(action === "withdraw" && m.mint === policy.shareMint && -d === rawAmount(exactInputRaw!)) && !(action === "convert" && m.mint === inputMint && -d === rawAmount(exactInputRaw!))) throw new Error("CYCLE_UNAUTHORIZED_TOKEN_DEBIT");
  }
  if (action === "contribute" && delta(policy.owner, MAINNET_USDC) !== -rawAmount(policy.limits.depositUsdcRaw)) throw new Error("CYCLE_CONTRIBUTION_DEBIT_MISMATCH");
  if (action === "withdraw" && delta(policy.owner, policy.shareMint) !== -rawAmount(exactInputRaw!)) throw new Error("CYCLE_BURN_AMOUNT_MISMATCH");
  if (action === "convert" && (delta(policy.owner, inputMint!) !== -rawAmount(exactInputRaw!) || delta(policy.owner, MAINNET_USDC) < rawAmount(minOutputRaw!))) throw new Error("CYCLE_CONVERSION_BOUNDS");
  if (action === "create" || action === "withdraw") {
    const a = after.get(chain.intentAddress); if (!a || !bounty) throw new Error("CYCLE_NATIVE_INTENT_NOT_CREATED");
    const created = RebalanceIntentLayout.decode(a.data.subarray(8));
    if (BigInt(created.bounty.bountyLeft.toString()) > rawAmount(bounty.fundingRaw) || delta(payer, WSOL_MINT) !== 0n) throw new Error("CYCLE_BOUNTY_FUNDING_RECONCILIATION");
  }
  if (action === "fill" && i) {
    if (delta(payer, MAINNET_USDC) !== 0n) throw new Error("CYCLE_KEEPER_FLASH_CREDIT_LEAK");
    const usdcPrice = fractionRaw(i.tokens.find(t => t.mint.toBase58() === MAINNET_USDC)!.price.price);
    const surplus = record.vaultLegs.reduce((sum, l) => { const t = i.tokens.find(t => t.mint.toBase58() === l.mint); return sum + delta(payer, l.mint) * (t ? fractionRaw(t.price.price) : 0n); }, 0n);
    if (usdcPrice <= 0n || (surplus + usdcPrice - 1n) / usdcPrice + rawAmount(state.keeperSurplusUsdcRaw) > rawAmount(policy.limits.maxKeeperSurplusUsdcRaw)) throw new Error("CYCLE_SIMULATED_KEEPER_SURPLUS_CAP");
    surplusPricesQ = Object.fromEntries(i.tokens.map(t => [t.mint.toBase58(), fractionRaw(t.price.price).toString()]));
  }
  if (action === "mint" && i) {
    const account = after.get(policy.vault); if (!account) throw new Error("CYCLE_MINT_POST_VAULT");
    const post = { ...chain.vault, ...VaultLayout.decode(account.data.subarray(8)) } as Vault;
    const prices = new Map(i.tokens.map(t => [t.mint.toBase58(), fractionRaw(t.price.price)]));
    const value = (v: Vault) => v.composition.slice(0, v.numTokens).reduce((sum, t) => { const p = prices.get(t.mint.toBase58()); if (!t.amount.isZero() && (!p || p <= 0n)) throw new Error("CYCLE_UNPRICED_BACKING"); return sum + BigInt(t.amount.toString()) * (p ?? 0n); }, 0n);
    const postSupply = unpackMint(pk(policy.shareMint), after.get(policy.shareMint)!, TOKEN_PROGRAM_ID).supply;
    const fees = (v: Vault) => Object.values(v.accumulatedFees).reduce((sum, n) => sum + BigInt(n.toString()), 0n);
    assertMintEffects({ beforeSupply: chain.shareSupply.toString(), afterSupply: postSupply.toString(), beforeOutstanding: chain.vault.supplyOutstanding.toString(), afterOutstanding: post.supplyOutstanding.toString(), ownerShareDelta: delta(policy.owner, policy.shareMint).toString(), feeShareDelta: delta(getVaultFeesPda(pk(policy.vault)).toBase58(), policy.shareMint).toString(), feeAccrualDelta: (fees(post) - fees(chain.vault)).toString(), minNetSharesRaw: policy.limits.minNetSharesRaw, beforeValueQ: value(chain.vault), contributedValueQ: value(post) - value(chain.vault), usdcPriceQ: prices.get(MAINNET_USDC) ?? 0n, maxRoundingLossUsdcRaw: policy.limits.maxRoundingLossUsdcRaw });
  }
  const fee = (await native.connection.getFeeForMessage(tx.message, "confirmed")).value;
  if (fee === null || !Number.isSafeInteger(fee) || fee < 0) throw new Error("CYCLE_NETWORK_FEE_UNAVAILABLE");
  const preLamports = before.get(payer)?.lamports, postLamports = after.get(payer)?.lamports;
  if (!Number.isSafeInteger(preLamports) || !Number.isSafeInteger(postLamports)) throw new Error("CYCLE_PAYER_BALANCE_UNAVAILABLE");
  // Conservative upper bound: add the network fee even if this RPC's simulation included it.
  const debit = BigInt(Math.max(0, preLamports! - postLamports!)) + BigInt(fee);
  if (debit > rawAmount(remaining) || deadline <= Date.now()) throw new Error("CYCLE_SOL_CAP_OR_EXPIRED_SIMULATION");
  const beforeStateHash = hashObject(watch.map(k => { const a = before.get(k.toBase58()); return [k.toBase58(), a ? [a.owner.toBase58(), sha256(a.data), a.lamports.toString()] : null]; }));
  return { action, reason: "Verified unsigned native step; signature and finalized reconciliation remain separate.", pending: { ...wire, stepId, bounty, action, policyHash: state.policyHash, expiresAt: deadline, lastValidBlockHeight: latest.lastValidBlockHeight, minSlot: block.context.slot, surplusPricesQ, beforeStateHash, simulatedPayerDebitLamports: debit.toString(), inputMint, exactInputRaw, minOutputRaw, signature: null, signedTransaction: null } };
}
