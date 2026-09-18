import { PublicKey, VersionedTransaction, TransactionMessage, ComputeBudgetProgram, type Connection, type AccountInfo, type TransactionInstruction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, unpackMint, unpackAccount, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { VAULTS_V3_PROGRAM_ID } from "@symmetry-hq/sdk/dist/constants.js";
import { VaultLayout } from "@symmetry-hq/sdk/dist/layouts/basket.js";
import { GlobalConfigLayout } from "@symmetry-hq/sdk/dist/layouts/config.js";
import { RebalanceIntentLayout, RebalanceType, type RebalanceIntent } from "@symmetry-hq/sdk/dist/layouts/intents/rebalanceIntent.js";
import { getRebalanceIntentPda, getGlobalConfigPda, getRentPayerPda } from "@symmetry-hq/sdk/dist/instructions/pda.js";
import { createRebalanceIntentIx, resizeRebalanceIntentIx, initRebalanceIntentIx, cancelRebalanceIx } from "@symmetry-hq/sdk/dist/instructions/automation/rebalanceIntent.js";
import { depositTokensIx, lockDepositsIx } from "@symmetry-hq/sdk/dist/instructions/user/deposit.js";
import { redeemTokensIx } from "@symmetry-hq/sdk/dist/instructions/user/withdraw.js";
import { claimBountyIx } from "@symmetry-hq/sdk/dist/instructions/automation/claimBounty.js";
import type { Vault, GlobalConfig } from "@symmetry-hq/sdk";
import BN from "bn.js";
import { hashObject, rawAmount, sdkRawAmount, sha256, weightsValid } from "../index-vaults/amounts.ts";
import { cyclePolicyHash, cycleDefinitionHash, cycleActivationBlockers, type CyclePolicy } from "../index-vaults/cycle-policy-parse.ts";
import { cycleMemo, CYCLE_OWNER_ACTIONS, type CycleOwnerAction } from "../index-vaults/cycle-memo-parse.ts";
import { assertCycleMint } from "../index-vaults/cycle-mint-parse.ts";
import { buildCycleRoute, type PoolMetadata } from "../index-vaults/cycle-routes.ts";
import { isolateCycleBounty } from "../index-vaults/cycle-bounty.ts";
import { assertCycleBacking } from "../index-vaults/cycle-accounting.ts";
import { feeSnapshot } from "../index-vaults/fees.ts";
import { assertNativeSupportTargets, MAINNET_USDC, NATIVE_DEFAULT_BINDINGS } from "../index-vaults/native-defaults.ts";
import { assertRaydiumOnlyVault, WSOL_MINT } from "../index-vaults/raydium-oracles.ts";
import type { CycleMintBinding } from "../index-vaults/cycle-receipt-parse.ts";
import type { PersistedVaultDefinition } from "../index-vaults/vault-definition-store.ts";
import type { CycleState, CyclePending } from "../index-vaults/cycle-store.ts";
import { readCycleWalletHistory, type CycleWalletHistory } from "./cycle-history.ts";
const pk = (s: string) => new PublicKey(s);
const ata = (owner: string, m: CycleMintBinding) => getAssociatedTokenAddressSync(pk(m.mint), pk(owner), true, pk(m.tokenProgram));
const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";

/** Owner-only independent wallet gate. Never signs/sends. Rebuild actual instructions from
 * approved policy, live native state and independently scanned finalized history; neither
 * journal summaries nor a server message hash authorize spending. Simulation is a client
 * bound, NOT an atomic minimum-share/surplus/all-transactions-exit guarantee. */
export async function validateCycleOwnerTransaction(input: {
  connection: Connection; policy: CyclePolicy; record: PersistedVaultDefinition; state: CycleState;
  pending: CyclePending; wallet: string; metadata?: PoolMetadata;
}) {
  const { connection, policy, record, state, pending: p } = input, owner = pk(policy.owner), vaultAddress = pk(policy.vault);
  const now = Date.now();
  if (input.wallet !== policy.owner || p.payer !== policy.owner || policy.owner === policy.keeper || p.signature || p.signedTransaction || p.policyHash !== cyclePolicyHash(policy) || state.policyHash !== p.policyHash || policy.definitionHash !== cycleDefinitionHash(record) || record.indexId !== policy.indexId || record.vaultAddress !== policy.vault || record.shareMint !== policy.shareMint || record.network !== "mainnet-beta") throw new Error("CYCLE_WALLET_SCOPE");
  if (cycleActivationBlockers(policy).length || policy.expiresAt <= now || p.expiresAt <= now || p.expiresAt > policy.expiresAt || !Number.isSafeInteger(policy.notBeforeSlot) || p.minSlot < policy.notBeforeSlot) throw new Error("CYCLE_WALLET_AUTHORITY_OR_EXPIRY");
  if (!(CYCLE_OWNER_ACTIONS as readonly string[]).includes(p.action)) throw new Error("CYCLE_WALLET_OWNER_ACTION_REQUIRED");
  if (await connection.getGenesisHash() !== MAINNET_GENESIS) throw new Error("CYCLE_WALLET_WRONG_NETWORK");
  if (await connection.getBlockHeight("confirmed") > p.lastValidBlockHeight || !(await connection.isBlockhashValid(p.blockhash, { commitment: "confirmed", minContextSlot: p.minSlot })).value) throw new Error("CYCLE_WALLET_BLOCKHASH_EXPIRED");
  const tx = VersionedTransaction.deserialize(Buffer.from(p.txBase64, "base64"));
  if (tx.serialize().length > 1232 || tx.message.header.numRequiredSignatures !== 1 || tx.message.staticAccountKeys[0].toBase58() !== policy.owner || tx.message.recentBlockhash !== p.blockhash || tx.signatures.some(s => s.some(n => n !== 0)) || sha256(tx.message.serialize()) !== p.messageHash) throw new Error("CYCLE_WALLET_UNSIGNED_MESSAGE");
  const tables = await Promise.all(tx.message.addressTableLookups.map(async l => {
    const t = await connection.getAddressLookupTable(l.accountKey, { commitment: "confirmed" });
    if (!t.value || t.value.state.deactivationSlot !== 0xffffffffffffffffn || t.value.state.lastExtendedSlot >= t.context.slot) throw new Error("CYCLE_WALLET_LOOKUP_UNAVAILABLE");
    return t.value;
  }));
  const intentAddress = getRebalanceIntentPda(vaultAddress, owner), globalAddress = getGlobalConfigPda();
  const ids = [...new Set([policy.vault, intentAddress.toBase58(), globalAddress.toBase58(), policy.shareMint, MAINNET_USDC, WSOL_MINT, ...record.vaultLegs.map(l => l.mint)])];
  const accounts = new Map<string, AccountInfo<Buffer> | null>(); let slot: number | undefined;
  for (let start = 0; start < ids.length; start += 100) {
    const batch = ids.slice(start, start + 100), result = await connection.getMultipleAccountsInfoAndContext(batch.map(pk), "confirmed");
    if (slot !== undefined && result.context.slot !== slot) throw new Error("CYCLE_WALLET_SNAPSHOT_RACE");
    slot = result.context.slot; batch.forEach((id, n) => accounts.set(id, result.value[n]));
  }
  for (const id of [policy.vault, globalAddress.toBase58(), ...(accounts.get(intentAddress.toBase58()) ? [intentAddress.toBase58()] : [])]) if (!accounts.get(id)?.owner.equals(VAULTS_V3_PROGRAM_ID)) throw new Error("CYCLE_WALLET_NATIVE_ACCOUNT_OWNER");
  const vault = { ...VaultLayout.decode(accounts.get(policy.vault)!.data.subarray(8)), ownAddress: vaultAddress } as Vault;
  const global = GlobalConfigLayout.decode(accounts.get(globalAddress.toBase58())!.data.subarray(8)) as GlobalConfig;
  const intentAccount = accounts.get(intentAddress.toBase58()), intent = intentAccount ? RebalanceIntentLayout.decode(intentAccount.data.subarray(8)) as RebalanceIntent : null;
  if (vault.mint.toBase58() !== policy.shareMint || (intent && (!intent.owner.equals(owner) || !intent.vault.equals(vaultAddress)))) throw new Error("CYCLE_WALLET_NATIVE_IDENTITY");
  const allocated = vault.composition.slice(0, vault.numTokens), expectedMints = [...record.vaultLegs.map(l => l.mint), MAINNET_USDC, WSOL_MINT];
  if (vault.numTokens > 100 || new Set(expectedMints).size !== expectedMints.length || allocated.length !== expectedMints.length || allocated.some(t => !expectedMints.includes(t.mint.toBase58()))) throw new Error("CYCLE_WALLET_COMPOSITION");
  for (const leg of record.vaultLegs) {
    const token = allocated.find(t => t.mint.toBase58() === leg.mint)!;
    if (leg.kind !== "raydium_clmm" || token.weight !== leg.targetWeightBps || !token.active) throw new Error("CYCLE_WALLET_DEFINITION_CHANGED");
  }
  vault.lutPubkeys = [];
  for (const [n, key] of [...vault.lookupTables.active, ...vault.lookupTables.temp].entries()) {
    if (key.equals(PublicKey.default)) continue;
    const lookup = await connection.getAddressLookupTable(key, { commitment: "confirmed" });
    if (!lookup.value || lookup.value.state.deactivationSlot !== 0xffffffffffffffffn || lookup.value.state.lastExtendedSlot >= lookup.context.slot) throw new Error("CYCLE_WALLET_NATIVE_LOOKUP_UNAVAILABLE");
    vault.lutPubkeys[n] = lookup.value;
  }
  assertNativeSupportTargets(vault);
  assertRaydiumOnlyVault(vault, [...record.vaultLegs.map(l => ({ mint: l.mint, pool: l.pool, kind: "raydium_clmm" as const })), ...NATIVE_DEFAULT_BINDINGS]);
  const bindings: CycleMintBinding[] = [...expectedMints, policy.shareMint].map(mint => {
    const a = accounts.get(mint); if (!a || ![TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].some(p => a.owner.equals(p))) throw new Error("CYCLE_WALLET_MINT_OWNER");
    const decoded = unpackMint(pk(mint), a, a.owner); assertCycleMint(decoded);
    const decimals = mint === MAINNET_USDC || mint === policy.shareMint ? 6 : mint === WSOL_MINT ? 9 : record.vaultLegs.find(l => l.mint === mint)!.decimals;
    if (decoded.decimals !== decimals || (mint === policy.shareMint && (decoded.supply.toString() !== vault.supplyOutstanding.toString() || !a.owner.equals(TOKEN_PROGRAM_ID)))) throw new Error("CYCLE_WALLET_MINT_SUPPLY_OR_PRECISION");
    return { mint, tokenProgram: a.owner.toBase58(), decimals };
  });
  const binding = (mint: string) => { const m = bindings.find(m => m.mint === mint); if (!m) throw new Error("CYCLE_WALLET_UNKNOWN_MINT"); return m; };
  const fees = feeSnapshot(vault, global), feeHash = hashObject({ host: fees.host, entry: fees.hostEntryFeeBps, exit: fees.hostExitFeeBps, protocol: fees.protocol });
  if (["create", "contribute", "lock", "withdraw"].includes(p.action) && (!fees.stocklanaFeesValid || feeHash !== policy.feeScheduleHash)) throw new Error("CYCLE_WALLET_UNAPPROVED_FEES");
  weightsValid(record.vaultLegs);
  const investing = ["create", "contribute", "lock"].includes(p.action);
  if (investing && (record.status !== "CREATABLE" || record.depositsEnabled !== true || record.coverage?.poolReadyOfMappedBps !== 10000 || record.poolExcludedLegs?.length || record.blockedReasons?.length || record.keeper.pubkey !== policy.keeper || record.keeper.automationEnabled !== true)) throw new Error("CYCLE_WALLET_DEPOSITS_UNREADY");
  // Independent canonical backing including every investor liability. Discovery/slot races
  // fail closed; noncanonical accounts never disguise an actual canonical deficit.
  const discover = () => connection.getProgramAccounts(VAULTS_V3_PROGRAM_ID, { commitment: "confirmed", filters: [{ dataSize: RebalanceIntentLayout.span + 8 }, { memcmp: { offset: 8, bytes: policy.vault } }] });
  const rows = await discover(), liabilities = rows.map(r => {
    const decoded = RebalanceIntentLayout.decode(r.account.data.subarray(8)) as RebalanceIntent;
    if (!decoded.vault.equals(vaultAddress) || decoded.rebalanceType === RebalanceType.Vault) throw new Error("CYCLE_WALLET_ACTIVE_NATIVE_REBALANCE");
    return { chain_data: { ...decoded, ownAddress: r.pubkey } };
  });
  const snapshotKeys = [...new Set([...ids, ...rows.map(r => r.pubkey.toBase58()), ...bindings.map(m => ata(policy.vault, m).toBase58())])];
  const chunks: string[][] = []; for (let n = 0; n < snapshotKeys.length; n += 100) chunks.push(snapshotKeys.slice(n, n + 100));
  const snapshots = await Promise.all(chunks.map(keys => connection.getMultipleAccountsInfoAndContext(keys.map(pk), "confirmed")));
  if (!snapshots.every(s => s.context.slot === snapshots[0].context.slot)) throw new Error("CYCLE_WALLET_BACKING_SLOT_RACE");
  const snapshot = new Map(snapshotKeys.map((key, n) => [key, snapshots[Math.floor(n / 100)].value[n % 100]]));
  for (const [key, original] of [...accounts, ...rows.map(r => [r.pubkey.toBase58(), r.account] as const)]) {
    const current = snapshot.get(key);
    if ((current?.data.toString("base64") ?? null) !== (original?.data.toString("base64") ?? null) || current?.owner.toBase58() !== original?.owner.toBase58()) throw new Error("CYCLE_WALLET_NATIVE_SNAPSHOT_CHANGED");
  }
  const actual = new Map<string, bigint>();
  for (const m of bindings) {
    const key = ata(policy.vault, m), a = snapshot.get(key.toBase58()); if (!a) continue;
    const t = unpackAccount(key, a, pk(m.tokenProgram));
    if (!t.owner.equals(vaultAddress) || !t.mint.equals(pk(m.mint)) || t.isFrozen || t.delegate || t.closeAuthority) throw new Error("CYCLE_WALLET_BACKING_AUTHORITY");
    actual.set(m.mint, t.amount);
  }
  if (hashObject((await discover()).map(r => [r.pubkey.toBase58(), sha256(r.account.data)]).sort()) !== hashObject(rows.map(r => [r.pubkey.toBase58(), sha256(r.account.data)]).sort())) throw new Error("CYCLE_WALLET_INTENT_DISCOVERY_RACE");
  assertCycleBacking(vault, liabilities, actual, investing ? "strict" : "recovery");
  if (p.action === "contribute" && !intent) throw new Error("CYCLE_WALLET_CONTRIBUTION");
  const history = await readCycleWalletHistory(connection, policy, bindings);
  assertHistoryMatchesState(history, state);
  const original = TransactionMessage.decompile(tx.message, { addressLookupTableAccounts: tables });
  let instructions: TransactionInstruction[];
  if (p.action === "create" || p.action === "withdraw") {
    if (intent || !p.bounty || (p.action === "create" && history.depositSignature) || (p.action === "withdraw" && (!history.depositSignature || history.exitSignature))) throw new Error("CYCLE_WALLET_NATIVE_GENERATION");
    if (rawAmount(p.bounty.fundingRaw) + history.bountyFundingRaw > rawAmount(policy.limits.maxBountyRaw)) throw new Error("CYCLE_WALLET_BOUNTY_CAP");
    const rentPayer = getRentPayerPda(), rentAccount = await connection.getAccountInfo(rentPayer, "confirmed");
    const rent = await connection.getMinimumBalanceForRentExemption(RebalanceIntentLayout.span + 8, "confirmed");
    const burn = p.action === "withdraw" ? history.mintedSharesRaw - history.burnedSharesRaw : 0n;
    if (p.action === "withdraw" && (burn <= 0n || p.exactInputRaw !== burn.toString() || p.inputMint !== policy.shareMint)) throw new Error("CYCLE_WALLET_BURN_AMOUNT");
    let mintHash: Buffer = Buffer.alloc(32);
    for (const token of allocated) mintHash = Buffer.from(sha256(Buffer.concat([mintHash, token.mint.toBuffer()])), "hex");
    const native = [createRebalanceIntentIx({ signer: owner, owner, vault: vaultAddress }), resizeRebalanceIntentIx(intentAddress), initRebalanceIntentIx({ signer: owner, owner, vault: vaultAddress, vaultTokenMint: pk(policy.shareMint), rebalanceIntentRentPayer: (rentAccount?.lamports ?? 0) >= rent + 100000 ? rentPayer : owner, bountyMint: pk(WSOL_MINT), rebalanceType: p.action === "create" ? RebalanceType.Deposit : RebalanceType.Withdraw, vaultRebalanceIntent: undefined, rebalanceSlippageBps: policy.limits.rebalanceSlippageBps, perTradeRebalanceSlippageBps: policy.limits.perTradeSlippageBps, executionStartTime: 0, minBountyAmount: 0, maxBountyAmount: 0,
      ...(p.action === "withdraw" ? { withdrawParamsBurnAmount: sdkRawAmount(burn.toString()), withdrawParamsTokenMintsHash: [...mintHash], withdrawParamsKeepTokensBitmask: new BN(1).shln(vault.numTokens).subn(1), withdrawParamsKeepAllTokens: 1 } : {}) })];
    const bounded = await isolateCycleBounty({ connection, owner: policy.owner, fundingRaw: p.bounty.fundingRaw, maximumRaw: (rawAmount(policy.limits.maxBountyRaw) - history.bountyFundingRaw).toString(), instructions: native });
    if (bounded.account !== p.bounty.account || bounded.restoreWsolRaw !== p.bounty.restoreWsolRaw) throw new Error("CYCLE_WALLET_WSOL_CHANGED");
    instructions = bounded.instructions;
  } else if (p.action === "contribute") {
    if (!intent || !history.depositSignature || history.contributedUsdcRaw !== 0n || intent.rebalanceType !== RebalanceType.Deposit || intent.tokens.some(t => !t.amount.isZero()) || p.exactInputRaw !== policy.limits.depositUsdcRaw || p.inputMint !== MAINNET_USDC) throw new Error("CYCLE_WALLET_CONTRIBUTION");
    instructions = depositTokensIx({ owner, vault: vaultAddress, contributions: [{ mint: pk(MAINNET_USDC), amount: sdkRawAmount(policy.limits.depositUsdcRaw), tokenProgram: pk(binding(MAINNET_USDC).tokenProgram) }] });
  } else if (p.action === "lock") {
    if (!intent || history.contributedUsdcRaw !== rawAmount(policy.limits.depositUsdcRaw)) throw new Error("CYCLE_WALLET_LOCK_UNFUNDED");
    instructions = [lockDepositsIx({ owner, vault: vaultAddress })];
  } else if (p.action === "cancel") {
    if (!intent || !history.depositSignature || history.mintedSharesRaw !== 0n || intent.rebalanceType !== RebalanceType.Deposit) throw new Error("CYCLE_WALLET_CANCEL_SCOPE");
    instructions = [cancelRebalanceIx({ keeper: owner, vault: vaultAddress, rebalanceIntent: intentAddress })];
  } else if (p.action === "claim") {
    if (!intent || !history.depositSignature) throw new Error("CYCLE_WALLET_CLAIM_GENERATION");
    const tokens = intent.tokens.filter(t => !t.amount.isZero()).slice(0, 5);
    if (!tokens.length) throw new Error("CYCLE_WALLET_EMPTY_CLAIM");
    instructions = [redeemTokensIx({ keeper: owner, owner, vault: vaultAddress, tokenMints: tokens.map(t => t.mint), tokenPrograms: tokens.map(t => pk(binding(t.mint.toBase58()).tokenProgram)) })];
  } else if (p.action === "cleanup") {
    if (!intent || !history.depositSignature) throw new Error("CYCLE_WALLET_CLEANUP_GENERATION");
    const keepers = [...new Set([intent.auctionCreationTask, intent.cancelRebalanceTask, intent.placeholderTask, intent.finishPriceUpdateTask, intent.mintVaultTask, ...intent.priceUpdateTasks, ...intent.tokenSettlementTasks].map(t => t.completedBy.toBase58()).filter(k => k !== PublicKey.default.toBase58()))].slice(0, 10);
    instructions = [claimBountyIx({ keeper: owner, vault: vaultAddress, intent: intentAddress, bountyMint: intent.bounty.bountyMint, bountyDepositor: intent.bounty.bountyDepositor, rentPayer: intent.rentPayer, keepers: keepers.map(pk) })];
  } else if (p.action === "convert") {
    const leg = record.vaultLegs.find(l => l.mint === p.inputMint), remaining = history.remainingCredits.get(p.inputMint ?? "") ?? 0n;
    if (!leg || !p.minOutputRaw || remaining <= 0n || p.exactInputRaw !== remaining.toString() || history.externalCreditDisposal) throw new Error("CYCLE_WALLET_UNATTRIBUTABLE_SALE");
    const other = [...history.remainingCredits].some(([mint, amount]) => mint !== leg.mint && amount > 0n);
    if (!other && rawAmount(p.minOutputRaw) + history.recoveredUsdcRaw < rawAmount(policy.limits.minExitUsdcRaw)) throw new Error("CYCLE_WALLET_LAST_EXIT_MINIMUM");
    const route = await buildCycleRoute({ connection, leg, owner: policy.owner, inputMint: leg.mint, outputMint: MAINNET_USDC, amountInRaw: remaining.toString(), minimumOutRaw: p.minOutputRaw, slippageBps: policy.limits.swapSlippageBps, maxAgeMs: policy.limits.quoteMaxAgeMs, metadata: input.metadata });
    // Price/tick movement must not silently weaken the already issued message.
    instructions = [route.instruction];
  } else throw new Error("CYCLE_WALLET_ACTION_UNSUPPORTED");
  const expected = new TransactionMessage({ payerKey: owner, recentBlockhash: p.blockhash, instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: policy.limits.maxComputeUnits }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: rawAmount(policy.limits.maxMicroLamports) }), ...instructions, cycleMemo(policy, p.action as CycleOwnerAction)] }).compileToV0Message(tables);
  if (!Buffer.from(expected.serialize()).equals(Buffer.from(tx.message.serialize())) || original.payerKey.toBase58() !== policy.owner) throw new Error("CYCLE_WALLET_SEMANTIC_MESSAGE_MISMATCH");
  const keys = tx.message.getAccountKeys({ addressLookupTableAccounts: tables }), watch = Array.from({ length: keys.length }, (_, n) => keys.get(n)!);
  const before = await connection.getMultipleAccountsInfoAndContext(watch, "confirmed");
  const sim = await connection.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: false, commitment: "confirmed", minContextSlot: before.context.slot, accounts: { encoding: "base64", addresses: watch.map(k => k.toBase58()) } });
  if (sim.value.err || !sim.value.accounts || sim.value.accounts.length !== watch.length) throw new Error("CYCLE_WALLET_SIMULATION_REFUSED");
  const after = sim.value.accounts.map(a => a ? { ...a, owner: pk(a.owner), data: Buffer.from(a.data[0], "base64") } : null);
  const tokenBalance = (values: (AccountInfo<Buffer> | null)[], m: CycleMintBinding) => {
    const index = watch.findIndex(k => k.equals(ata(policy.owner, m))); if (index < 0 || !values[index]) return 0n;
    const token = unpackAccount(watch[index], values[index]!, pk(m.tokenProgram));
    if (!token.owner.equals(owner) || !token.mint.equals(pk(m.mint)) || token.isFrozen || token.delegate || token.closeAuthority) throw new Error("CYCLE_WALLET_TOKEN_AUTHORITY");
    return token.amount;
  };
  const deltas = new Map(bindings.map(m => [m.mint, tokenBalance(after, m) - tokenBalance(before.value, m)]));
  const expectedDebit = p.action === "contribute" ? [MAINNET_USDC, policy.limits.depositUsdcRaw] : p.action === "withdraw" ? [policy.shareMint, (history.mintedSharesRaw - history.burnedSharesRaw).toString()] : p.action === "convert" ? [p.inputMint!, p.exactInputRaw!] : null;
  for (const [mint, delta] of deltas) if (delta < 0n && (!expectedDebit || mint !== expectedDebit[0] || delta !== -rawAmount(expectedDebit[1]))) throw new Error("CYCLE_WALLET_UNEXPECTED_DEBIT");
  if (expectedDebit && deltas.get(expectedDebit[0]) !== -rawAmount(expectedDebit[1])) throw new Error("CYCLE_WALLET_MISSING_EXPECTED_DEBIT");
  if (p.action === "convert" && (deltas.get(MAINNET_USDC) ?? 0n) < rawAmount(p.minOutputRaw!)) throw new Error("CYCLE_WALLET_CONVERSION_MINIMUM");
  const fee = (await connection.getFeeForMessage(tx.message, "confirmed")).value;
  if (fee === null || !Number.isSafeInteger(fee) || !before.value[0] || !after[0]) throw new Error("CYCLE_WALLET_FEE_UNAVAILABLE");
  const cost = BigInt(Math.max(0, before.value[0].lamports - after[0].lamports)) + BigInt(fee);
  if (cost + history.ownerSolDebitLamports > rawAmount(policy.limits.maxOwnerSolDebitLamports)) throw new Error("CYCLE_WALLET_SOL_CAP");
  if (p.action === "withdraw") {
    const n = watch.findIndex(k => k.equals(intentAddress));
    if (n < 0 || !after[n]) throw new Error("CYCLE_WALLET_NO_SIMULATED_CLAIMS");
    const claim = RebalanceIntentLayout.decode(after[n]!.data.subarray(8)) as RebalanceIntent;
    let minimum = history.recoveredUsdcRaw;
    for (const t of claim.tokens) {
      if (t.amount.isZero()) continue;
      if (t.mint.toBase58() === MAINNET_USDC) { minimum += BigInt(t.amount.toString()); continue; }
      const leg = record.vaultLegs.find(l => l.mint === t.mint.toBase58());
      if (!leg) throw new Error("CYCLE_WALLET_UNPROVED_SUPPORT_EXIT");
      const route = await buildCycleRoute({ connection, leg, owner: policy.owner, inputMint: leg.mint, outputMint: MAINNET_USDC, amountInRaw: t.amount.toString(), slippageBps: policy.limits.swapSlippageBps, maxAgeMs: policy.limits.quoteMaxAgeMs, metadata: input.metadata });
      minimum += rawAmount(route.minOutRaw);
    }
    if (minimum < rawAmount(policy.limits.minExitUsdcRaw)) throw new Error("CYCLE_WALLET_AFTER_FEE_EXIT_MINIMUM");
  }
  if (Date.now() >= p.expiresAt || Date.now() - now > policy.limits.quoteMaxAgeMs) throw new Error("CYCLE_WALLET_VALIDATION_EXPIRED");
  return { transaction: tx, messageHash: p.messageHash, action: p.action, simulatedSolDebitLamports: cost.toString() };
}
function assertHistoryMatchesState(history: CycleWalletHistory, state: CycleState): void {
  for (const field of ["ownerSolDebitLamports", "bountyFundingRaw", "contributedUsdcRaw", "mintedSharesRaw", "burnedSharesRaw", "recoveredUsdcRaw"] as const) if (history[field] !== rawAmount(state[field])) throw new Error(`CYCLE_WALLET_HISTORY_DIVERGENCE:${field}`);
  if (history.depositSignature !== state.depositGenerationSignature || history.exitSignature !== state.exitGenerationSignature) throw new Error("CYCLE_WALLET_GENERATION_HISTORY_DIVERGENCE");
  const credits = new Map<string, bigint>();
  for (const c of state.credits) if (c.mint !== MAINNET_USDC) credits.set(c.mint, (credits.get(c.mint) ?? 0n) + rawAmount(c.receivedRaw) - rawAmount(c.soldRaw));
  for (const mint of new Set([...credits.keys(), ...history.remainingCredits.keys()])) if ((credits.get(mint) ?? 0n) !== (history.remainingCredits.get(mint) ?? 0n)) throw new Error("CYCLE_WALLET_CREDIT_HISTORY_DIVERGENCE");
}
