import { readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { getRebalanceIntentPda } from "@symmetry-hq/sdk/dist/instructions/pda.js";
import { getSwapPairs } from "@symmetry-hq/sdk/dist/states/intents/rebalanceIntent.js";
import { RebalanceAction, RebalanceType } from "@symmetry-hq/sdk/dist/layouts/intents/rebalanceIntent.js";
import { getHeliusRpcUrl } from "../src/lib/helius.ts";
import { address } from "../src/lib/index-vaults/amounts.ts";
import { buildCycleFillWire } from "../src/lib/index-vaults/cycle-wire.ts";
import { buildCycleRoute } from "../src/lib/index-vaults/cycle-routes.ts";
import { kakuSanBuilders, kakuSanConnection, simulateUnsigned } from "../src/lib/index-vaults/kaku-san-create.ts";
import { assertIndexKeeper, legBindings, prepareWithdrawalKeeperStep } from "../src/lib/index-vaults/keeper-tick.ts";
import { MAINNET_USDC, NATIVE_DEFAULT_BINDINGS, assertNativeSupportTargets } from "../src/lib/index-vaults/native-defaults.ts";
import { assertNoPythEnvironment, assertRaydiumOnlyVault, WSOL_MINT } from "../src/lib/index-vaults/raydium-oracles.ts";
import { createServiceSupabase } from "../src/lib/supabase.ts";
import { readVaultDefinition, type PersistedVaultDefinition } from "../src/lib/index-vaults/vault-definition-store.ts";

const INDEX_ID = "idx-theme-mag7-caucus";
const VAULT = "AwDFvjEPPwdF1YgXV8asNt6LeEFDduinYneCn6mHDAsh";
const SHARE_MINT = "9ihGfswnUZ6MysSR3KgmrZ57FXDVAiAQ6sEHwLuWwzJ4";
const MAG7_KEEPER = "GLq9gScm99eUypsc5a7WsP7rmsc3aAUfpzqmAPNqXvmq";
const DEFAULT_POLL_MS = 15_000;
const MAX_SOL_DEBIT_LAMPORTS = 50_000_000n; // 0.05 SOL per watcher tick.

type Options = { owner?: string; watchVault: boolean; execute: boolean; watch: boolean; pollMs: number; keypair?: string };
type ScanIntent = {
  formatted_data: { pubkey: string };
  chain_data: { vault: { toBase58(): string }; owner: { toBase58(): string }; rebalanceType: RebalanceType; currentAction: RebalanceAction };
};
type TickResult = { action: string; intent?: string; signatures: string[]; spent: bigint; [key: string]: unknown };
type Mag7MintToken = { mint: string; amount: string; targetAmount: string };

const MAG7_SKIPPABLE_ROUTE_ERRORS = new Set([
  "CYCLE_ROUTE_MINIMUM_UNSATISFIABLE",
  // The direct CLMM quote cannot fill the native amount. In this fixed deposit
  // settler it is a dust/unroutable leg, not a reason to abandon prior fills.
  "CYCLE_NO_FULL_SIZE_ROUTE",
]);

/** Refuse zero/partial books even though the native mint instruction would accept them. */
export function mag7MintPlan(input: { investmentLegMints: readonly string[]; tokens: readonly Mag7MintToken[]; wsolMint: string }) {
  const amounts = new Map(input.tokens.map(token => [token.mint, BigInt(token.amount)]));
  const targets = new Map(input.tokens.map(token => [token.mint, BigInt(token.targetAmount)]));
  const filledLegMints = input.investmentLegMints.filter(mint => (amounts.get(mint) ?? 0n) > 0n && (targets.get(mint) ?? 0n) > 0n && amounts.get(mint)! >= targets.get(mint)!);
  const skippedLegMints = input.investmentLegMints.filter(mint => !filledLegMints.includes(mint));
  if (input.investmentLegMints.length !== 7 || new Set(input.investmentLegMints).size !== 7) return { mayMint: false, reason: "MAG7_EXPECTED_SEVEN_DISTINCT_LEGS", filledLegMints, skippedLegMints };
  if ((amounts.get(input.wsolMint) ?? 0n) > 0n) return { mayMint: false, reason: "MAG7_ACCOUNTED_SUPPORT_REQUIRES_RECONCILIATION", filledLegMints, skippedLegMints };
  if (!filledLegMints.length) return { mayMint: false, reason: "MAG7_NO_FILLED_LEGS_DO_NOT_MINT", filledLegMints, skippedLegMints };
  if (skippedLegMints.length) return { mayMint: false, reason: "MAG7_PARTIAL_FILL_DO_NOT_MINT", filledLegMints, skippedLegMints };
  return { mayMint: true, filledLegMints, skippedLegMints, unspentUsdcRaw: (amounts.get(MAINNET_USDC) ?? 0n).toString() };
}

/** Keep the all-seven check on the actual mint preparation boundary. */
export async function prepareMag7Mint<T>(input: Parameters<typeof mag7MintPlan>[0], mint: () => Promise<T>) {
  const plan = mag7MintPlan(input);
  if (!plan.mayMint) throw new Error(plan.reason);
  return { plan, payload: await mint() };
}

/** Only quote-size failures are dust skips; every other route failure stays fail-closed. */
export function mag7SkippableRouteReason(error: unknown): string | null {
  const message = error instanceof Error ? error.message : "";
  return MAG7_SKIPPABLE_ROUTE_ERRORS.has(message) ? message : null;
}

function usage() {
  return `Usage:
  npm run keeper:mag7-deposit -- --watch-vault --dry-run
  npm run keeper:mag7-deposit -- --watch-vault --execute --keypair /absolute/external/keeper.json --watch
  npm run keeper:mag7-deposit -- --watch-vault --execute --keypair /absolute/external/keeper.json --watch --interval-seconds 15
  npm run keeper:mag7-deposit -- --owner <locked-deposit-wallet> --dry-run

External VPS-only Mag7 deposit settler. With no --owner (the default) it scans every locked
native deposit intent for the fixed Mag7 vault, regardless of depositor, and settles each through
Raydium price/fill/mint/cleanup. --watch polls until Ctrl-C (15 seconds by default); each poll has
its own 0.05 SOL keeper SOL-debit cap. It never creates a user deposit, opens public funds, uses
Pyth/Hermes, uses the cycle journal, or loads a key in the app. Dry-run is the default and
broadcasts nothing.`;
}

export function parseArgs(argv: readonly string[]): Options {
  let owner: string | undefined, keypair: string | undefined, execute = false, watch = false, watchVault = false, pollMs = DEFAULT_POLL_MS;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = () => {
      const next = argv[++i];
      if (!next || next.startsWith("--")) throw new Error(`${flag} requires a value`);
      return next;
    };
    if (flag === "--owner") owner = address(value());
    else if (flag === "--keypair") keypair = value();
    else if (flag === "--execute") execute = true;
    else if (flag === "--dry-run") { /* Explicit spelling of the default. */ }
    else if (flag === "--watch") watch = true;
    else if (flag === "--watch-vault") watchVault = true;
    else if (flag === "--interval-seconds") {
      const seconds = Number(value());
      if (!Number.isSafeInteger(seconds) || seconds < 5 || seconds > 86_400) throw new Error("--interval-seconds must be an integer from 5 to 86400");
      pollMs = seconds * 1_000;
    } else throw new Error(`Unsupported argument ${flag}`);
  }
  // No owner is the safe normal-operation path: scan the one fixed vault, never all vaults.
  if (!owner) watchVault = true;
  if ((owner && watchVault) || (execute && !keypair) || (!execute && (keypair || watch)) || (execute && !isAbsolute(keypair!))) {
    throw new Error("Use --watch-vault (or omit --owner) to scan Mag7; --owner is single-intent only; --execute requires an absolute external --keypair path; --watch requires --execute");
  }
  return { ...(owner ? { owner } : {}), watchVault, execute, watch, pollMs, ...(keypair ? { keypair } : {}) };
}

/** Select finalized intents from the fixed Mag7 vault, including user withdrawals. */
export function lockedMag7IntentAddresses(intents: readonly ScanIntent[]): string[] {
  return intents
    .filter(intent => intent.chain_data.vault.toBase58() === VAULT
      && (intent.chain_data.rebalanceType === RebalanceType.Deposit || intent.chain_data.rebalanceType === RebalanceType.Withdraw)
      && intent.chain_data.currentAction !== RebalanceAction.DepositTokens
      && intent.chain_data.currentAction !== RebalanceAction.NotActive)
    .map(intent => intent.formatted_data.pubkey)
    .filter((intent, index, all) => all.indexOf(intent) === index);
}

export function lockedMag7DepositIntentAddresses(intents: readonly ScanIntent[]): string[] {
  return lockedMag7IntentAddresses(intents.filter(intent => intent.chain_data.rebalanceType === RebalanceType.Deposit));
}

function loadExternalKeypair(path: string): Keypair {
  const absolute = resolve(path), root = resolve(".");
  const outside = relative(root, absolute);
  if (!outside || (!outside.startsWith("..") && !isAbsolute(outside))) throw new Error("Keeper keypair must be outside this repository");
  const bytes: unknown = JSON.parse(readFileSync(absolute, "utf8"));
  if (!Array.isArray(bytes) || bytes.length !== 64 || bytes.some(b => !Number.isInteger(b) || b < 0 || b > 255)) throw new Error("Keypair file must be a 64-byte JSON array");
  const keypair = Keypair.fromSecretKey(Uint8Array.from(bytes));
  bytes.fill(0);
  return keypair;
}

function requireMag7Definition(record: PersistedVaultDefinition | null): PersistedVaultDefinition {
  if (!record || record.indexId !== INDEX_ID || record.vaultAddress !== VAULT || record.shareMint !== SHARE_MINT || record.network !== "mainnet-beta" || record.status !== "CREATABLE") {
    throw new Error("Persisted Mag7 definition/identity is not ready");
  }
  if (record.keeper?.pubkey !== MAG7_KEEPER || record.keeper.automationEnabled !== true) throw new Error("Persisted Mag7 keeper must be the configured automation wallet");
  if (record.vaultLegs.length !== 7) throw new Error("Persisted Mag7 definition must contain exactly seven investment legs");
  return record;
}

async function sendTransactions(input: { transactions: { txBase64: string }[]; keeper: Keypair; native: ReturnType<typeof kakuSanBuilders>; spent: bigint }) {
  const sender = kakuSanConnection(true, getHeliusRpcUrl());
  const signatures: string[] = [];
  let spent = input.spent;
  for (const transaction of input.transactions) {
    await simulateUnsigned(input.native.connection, transaction.txBase64);
    const tx = VersionedTransaction.deserialize(Buffer.from(transaction.txBase64, "base64"));
    if (tx.message.staticAccountKeys[0]?.toBase58() !== input.keeper.publicKey.toBase58()) throw new Error("Prepared transaction payer is not the keeper");
    const before = await sender.getBalance(input.keeper.publicKey, "confirmed");
    const fee = await sender.getFeeForMessage(tx.message, "confirmed");
    if (fee.value === null || spent + BigInt(fee.value) > MAX_SOL_DEBIT_LAMPORTS) throw new Error("MAG7_KEEPER_SOL_DEBIT_CAP");
    tx.sign([input.keeper]);
    const signature = await sender.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
    let landed = false;
    for (let attempt = 0; attempt < 40; attempt++) {
      const status = (await sender.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0];
      if (status?.err) throw new Error(`Transaction ${signature} failed: ${JSON.stringify(status.err)}`);
      if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") { landed = true; break; }
      await sleep(1_000);
    }
    if (!landed) throw new Error(`Transaction ${signature} did not confirm; reconcile before retrying`);
    const after = await sender.getBalance(input.keeper.publicKey, "confirmed");
    spent += BigInt(Math.max(0, before - after));
    if (spent > MAX_SOL_DEBIT_LAMPORTS) throw new Error("MAG7_KEEPER_SOL_DEBIT_CAP");
    signatures.push(signature);
  }
  return { signatures, spent };
}

async function missingKeeperAtas(native: ReturnType<typeof kakuSanBuilders>, record: PersistedVaultDefinition, keeper: string) {
  const mints = [...record.vaultLegs.map(leg => leg.mint), WSOL_MINT, MAINNET_USDC];
  const infos = await native.connection.getMultipleAccountsInfo(mints.map(mint => new PublicKey(mint)), "confirmed");
  const missing: string[] = [];
  for (const [index, mint] of mints.entries()) {
    const info = infos[index];
    if (!info) throw new Error(`Mint missing: ${mint}`);
    const ata = getAssociatedTokenAddressSync(new PublicKey(mint), new PublicKey(keeper), false, info.owner);
    const account = await native.connection.getAccountInfo(ata, "confirmed");
    if (!account?.owner.equals(info.owner)) missing.push(`${mint}:${ata.toBase58()}`);
  }
  return missing;
}

async function tickIntent(options: Options, spent: bigint, intentAddress: string): Promise<TickResult> {
  assertNoPythEnvironment();
  const db = createServiceSupabase();
  if (!db) throw new Error("Supabase service-role credentials are required");
  const record = requireMag7Definition(await readVaultDefinition(db, INDEX_ID));
  const native = kakuSanBuilders(false);
  await native.assertNetwork();
  const vault = await native.sdk.fetchVault(VAULT);
  if (vault.ownAddress.toBase58() !== VAULT || vault.mint.toBase58() !== SHARE_MINT) throw new Error("On-chain Mag7 vault identity mismatch");
  assertRaydiumOnlyVault(vault, [...legBindings(record.vaultLegs), ...NATIVE_DEFAULT_BINDINGS]);
  assertNativeSupportTargets(vault);
  const account = await native.connection.getAccountInfo(new PublicKey(intentAddress), "confirmed");
  if (!account) return { action: "wait", reason: "Locked deposit intent disappeared before settlement", intent: intentAddress, signatures: [], spent };
  const intent = await native.sdk.fetchRebalanceIntent(intentAddress);
  const chain = intent.chain_data;
  const owner = chain.owner.toBase58();
  if (chain.vault.toBase58() !== VAULT || (chain.rebalanceType !== RebalanceType.Deposit && chain.rebalanceType !== RebalanceType.Withdraw) || getRebalanceIntentPda(new PublicKey(VAULT), new PublicKey(owner)).toBase58() !== intentAddress) throw new Error("Native intent is not a Mag7 user operation");
  const isWithdrawal = chain.rebalanceType === RebalanceType.Withdraw;
  const action = chain.currentAction;
  const now = Math.floor(Date.now() / 1000);
  if (!options.execute) return { action: "dry-run", owner, intent: intentAddress, nativeAction: intent.formatted_data.current_action, executionStart: chain.executionStartTime.toString(), now, signatures: [], spent };

  const keeper = loadExternalKeypair(options.keypair!);
  const managers = (vault.settings as { managers?: { managers?: { toBase58(): string }[] } }).managers?.managers ?? [];
  const keeperAddress = assertIndexKeeper(keeper.publicKey.toBase58(), {
    deployer: vault.settings.creator.toBase58(), host: vault.settings.host.toBase58(), strategy: managers.map(manager => manager.toBase58()), namedKeeper: record.keeper.pubkey,
  });
  if (keeperAddress !== MAG7_KEEPER) throw new Error("MAG7_KEEPER_PUBKEY_MISMATCH");
  if (action === RebalanceAction.DepositTokens) return { action: "wait", reason: "User operation is not locked/finalized yet", intent: intentAddress, signatures: [], spent };

  if (isWithdrawal && action === RebalanceAction.Auction) {
    const plan = await prepareWithdrawalKeeperStep({ native, vault, intentAddress, keeper: keeperAddress,
      legs: record.vaultLegs, maxPriorityFeeLamports: (MAX_SOL_DEBIT_LAMPORTS - spent).toString() });
    if (!plan.eligible) return { action: "wait", reason: plan.reason, intent: intentAddress, signatures: [], spent };
    const result = await sendTransactions({ transactions: plan.transactions, keeper, native, spent });
    return { action: plan.step === "auction" ? "sell" : plan.step === "claim-bounty" ? "cleanup" : plan.step, intent: intentAddress, ...result };
  }

  // Cash-only redemption must not depend on unrelated keeper stock ATAs.
  const missing = await missingKeeperAtas(native, record, keeperAddress);
  if (missing.length) throw new Error(`Missing keeper ATAs: ${missing.join(", ")}`);

  if (action === RebalanceAction.UpdatePrices) {
    if (now < Number(chain.executionStartTime.toString())) return { action: "wait", reason: "Native execution start time has not arrived", intent: intentAddress, signatures: [], spent };
    const prepared = await native.priceUpdateFromVault(vault, keeperAddress, intentAddress, [...legBindings(record.vaultLegs), ...NATIVE_DEFAULT_BINDINGS]);
    const transactions = prepared.payload.batches.flatMap(batch => batch.transactions).map(tx => ({ txBase64: tx.tx_b64 }));
    const result = await sendTransactions({ transactions, keeper, native, spent });
    return { action: "prices", intent: intentAddress, ...result };
  }

  if (action === RebalanceAction.Auction) {
    const end = Number(chain.auctions[2]?.endTime.toString() ?? "0");
    if (now > end) {
      // No unsupported cancel/restart/empty mint to escape an expired failed deposit.
      const { plan, payload } = await prepareMag7Mint({ investmentLegMints: record.vaultLegs.map(leg => leg.mint), tokens: chain.tokens.map(token => ({ mint: token.mint.toBase58(), amount: token.amount.toString(), targetAmount: token.targetAmount.toString() })), wsolMint: WSOL_MINT },
        () => native.sdk.mintTx({ keeper: keeperAddress, rebalance_intent: intentAddress }));
      const result = await sendTransactions({ transactions: payload.batches.flatMap(batch => batch.transactions).map(tx => ({ txBase64: tx.tx_b64 })), keeper, native, spent });
      return { action: "mint", intent: intentAddress, filledLegMints: plan.filledLegMints, skippedLegMints: plan.skippedLegMints, unspentUsdcRaw: plan.unspentUsdcRaw, ...result };
    }
    // getSwapPairs refreshes native targets for the current auction window.
    const availablePairs = getSwapPairs(chain, vault);
    const plan = mag7MintPlan({ investmentLegMints: record.vaultLegs.map(leg => leg.mint), tokens: chain.tokens.map(token => ({ mint: token.mint.toBase58(), amount: token.amount.toString(), targetAmount: token.targetAmount.toString() })), wsolMint: WSOL_MINT });
    const missingLegs = new Set(plan.skippedLegMints);
    if (!missingLegs.size) return { action: "wait", reason: "All Mag7 investment legs are filled; waiting for the native auction to close", intent: intentAddress, signatures: [], spent };
    const pairs = availablePairs.filter(pair => pair.outMint === MAINNET_USDC && missingLegs.has(pair.inMint));
    const fills = [], skipped: Array<{ mint: string; ticker: string; reason: string }> = [];
    for (const pair of pairs) {
      const leg = record.vaultLegs.find(candidate => candidate.mint === pair.inMint);
      if (!leg || !Number.isSafeInteger(pair.inAmount) || !Number.isSafeInteger(pair.outAmount)) continue;
      try {
        const route = await buildCycleRoute({ connection: native.connection, leg, owner: keeperAddress, inputMint: MAINNET_USDC, outputMint: leg.mint,
          amountInRaw: String(pair.outAmount), minimumOutRaw: String(pair.inAmount), slippageBps: 50, maxAgeMs: 60_000 });
        fills.push({ route, maxRepaymentRaw: String(pair.inAmount) });
        if (fills.length === 2) break;
      } catch (error) {
        const reason = mag7SkippableRouteReason(error);
        if (!reason) throw error;
        skipped.push({ mint: leg.mint, ticker: leg.ticker, reason });
      }
    }
    if (!fills.length) return { action: "wait", reason: "No complete Raydium CLMM fill is available inside the native auction", skipped, intent: intentAddress, signatures: [], spent };
    const wire = await buildCycleFillWire({ native, keeper: keeperAddress, vault: VAULT, intent: intentAddress, fills, computeUnits: 1_400_000, microLamports: "25000", maxPriorityFeeLamports: (MAX_SOL_DEBIT_LAMPORTS - spent).toString() });
    const result = await sendTransactions({ transactions: [{ txBase64: wire.txBase64 }], keeper, native, spent });
    return { action: "fill", intent: intentAddress, filled: fills.map(fill => fill.route.outputMint), skipped, ...result };
  }

  if (intent.claim_bounty_data) {
    const payload = await native.sdk.claimBountyTx({ keeper: keeperAddress, rebalance_intent: intentAddress });
    const result = await sendTransactions({ transactions: payload.batches.flatMap(batch => batch.transactions).map(tx => ({ txBase64: tx.tx_b64 })), keeper, native, spent });
    return { action: "cleanup", intent: intentAddress, ...result };
  }
  return { action: "wait", reason: `Unsupported deposit intent action ${intent.formatted_data.current_action}`, intent: intentAddress, signatures: [], spent };
}

export async function settleMag7IntentBurst(
  options: Options,
  spent: bigint,
  intentAddress: string,
  advance: (options: Options, spent: bigint, intentAddress: string) => Promise<TickResult> = tickIntent,
): Promise<TickResult[]> {
  const results: TickResult[] = [];
  do {
    const result = await advance(options, spent, intentAddress);
    results.push(result);
    spent = result.spent;
    // Price updates open the short auction: do not sleep before the first fill.
    // Mint/redeem can leave cash/bounty cleanup; finish that before the next deposit.
    if (!["prices", "fill", "sell", "mint", "redeem"].includes(result.action) || spent >= MAX_SOL_DEBIT_LAMPORTS) return results;
  } while (true);
}

async function tick(options: Options) {
  const native = kakuSanBuilders(false);
  await native.assertNetwork();
  const intentAddresses = options.owner
    ? [getRebalanceIntentPda(new PublicKey(VAULT), new PublicKey(options.owner)).toBase58()]
    : lockedMag7IntentAddresses(await native.sdk.fetchVaultRebalanceIntents(VAULT) as ScanIntent[]);
  let spent = 0n;
  const results: Array<TickResult | { action: "error"; intent: string; error: string; signatures: []; spent: bigint }> = [];
  for (const intentAddress of intentAddresses) {
    try {
      const intentResults = await settleMag7IntentBurst(options, spent, intentAddress);
      const result = intentResults.at(-1)!;
      spent = result.spent;
      results.push(...intentResults);
      // Spending is global to this poll, including an exact-cap final fill.
      if (spent >= MAX_SOL_DEBIT_LAMPORTS) break;
    } catch (error) {
      const message = error instanceof Error ? error.message : "MAG7_KEEPER_REFUSED";
      results.push({ action: "error", intent: intentAddress, error: message, signatures: [], spent });
      // Spending is a global per-tick cap. Do not try another deposit once it is exhausted.
      if (message === "MAG7_KEEPER_SOL_DEBIT_CAP") break;
    }
  }
  return { scannedLockedIntents: intentAddresses.length, results, spent };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  do {
    // The SOL cap is deliberately reset for each poll, not shared across a weekend-long watcher.
    const result = await tick(options);
    console.log(JSON.stringify({ schema: "insiderindex-mag7-direct-settler-v2", indexId: INDEX_ID, vault: VAULT, shareMint: SHARE_MINT, keeper: MAG7_KEEPER, mode: options.execute ? "execute" : "dry-run", watchVault: options.watchVault, pollSeconds: options.pollMs / 1_000, maxSolDebitLamports: MAX_SOL_DEBIT_LAMPORTS.toString(), ...result, spent: result.spent.toString(), results: result.results.map(item => ({ ...item, spent: item.spent.toString() })) }, null, 2));
    if (!options.watch) break;
    await sleep(options.pollMs);
  } while (true);
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? "scripts/mag7-settle-deposit.mts")).href) {
  if (process.argv.includes("--help")) console.log(usage());
  else void main().catch(error => { console.error(error instanceof Error ? error.message : "MAG7_KEEPER_REFUSED"); process.exitCode = 1; });
}
