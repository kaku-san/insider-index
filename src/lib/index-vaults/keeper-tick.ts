/**
 * DB-driven InsiderIndex keeper tick — operable by index id.
 *
 * The tick loads ONE index's definition from `insiderindex_vault_definitions` (vault address, share
 * mint, pool-ready legs, target weight bps, cap, keeper and fee parameters) and reads everything
 * else from the DB record. There is no `--vault` / `--share-mint` argument and no hardcoded basket:
 * the four real vaults (Pelosi, Gottheimer, Mag7 Caucus, Silicon Hill) and any future index share
 * one shape.
 *
 * Contracts kept exactly as the Kaku San keeper:
 *   - the keeper keypair is a FILE PATH argument, never an environment variable in the web app, still
 *     refused inside the web app tree, and still refused when it equals the vault deployer, host or a
 *     strategy/manager wallet, or when the DB row names a different keeper.
 *   - DRY RUN IS THE DEFAULT. Without `--execute` the tick computes and prints current weights, target
 *     weights, drift against the shared eligibility rule and the trades it would place, and broadcasts
 *     nothing. Executing requires `--execute` AND passing the SAME shared eligibility rule.
 *   - the drift / eligibility maths stays in the shared `rebalance-eligibility` module (via
 *     `kaku-san-rebalance`): this file never adds a second copy or a private threshold.
 *   - a leg with no tradable pool is refused, never silently re-weighted around.
 *
 * This module builds the reviewable observation and the (optional) execute plan; it never holds a key
 * on the server. Key loading and broadcasting live only in the operator CLI seam injected here.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Keypair, PublicKey, VersionedTransaction, type Connection } from "@solana/web3.js";
import type { Vault } from "@symmetry-hq/sdk";
import { getRebalanceIntentPda } from "@symmetry-hq/sdk/dist/instructions/pda.js";
import { address } from "./amounts.ts";
import { assertNativeSupportTargets, hasUnreconciledSupportBalance, NATIVE_SUPPORT_BALANCE_REASON, NATIVE_DEFAULT_BINDINGS } from "./native-defaults.ts";
import {
  KAKU_SAN_NATIVE_TOKEN_CAP, assertNativeTokenCap, kakuSanDrift, kakuSanRebalanceEligibility,
  type KakuSanDriftRow, type KakuSanEligibility,
} from "./kaku-san-rebalance.ts";
import { payloadTransactions, simulateUnsigned } from "./kaku-san-create.ts";
import { assertNoPythEnvironment, assertRaydiumOnlyVault, type RaydiumPoolBinding } from "./raydium-oracles.ts";
import { GENESIS, SYMMETRY_PROGRAM_ID } from "./symmetry-adapter.ts";
import type { NativeVaultBuilders } from "./symmetry-adapter.ts";
import { keeperTargets, type PersistedVaultDefinition, type PersistedVaultLeg } from "./vault-definition-store.ts";

export const INDEX_KEEPER_SCHEMA = "stocklana-insiderindex-keeper-tick-v1" as const;

/** Refuse a keypair that lives inside the web app tree. Same contract as the Kaku San CLI. */
export function assertNotWebAppKeypair(path: string, root = resolve(".")): string {
  const resolved = resolve(path);
  for (const dir of ["src", "app", "public", ".next"]) {
    const blocked = resolve(root, dir);
    if (resolved === blocked || resolved.startsWith(`${blocked}/`)) throw new Error("Keeper keypair must not live in the web app tree");
  }
  return resolved;
}

/** Load a dedicated keeper hot wallet from a 64-byte JSON array file. Zeroes the parsed bytes. */
export function loadKeeperKeypair(path: string): Keypair {
  const parsed = JSON.parse(readFileSync(assertNotWebAppKeypair(path), "utf8"));
  if (!Array.isArray(parsed) || parsed.length !== 64 || parsed.some((b: unknown) => !Number.isInteger(b) || (b as number) < 0 || (b as number) > 255)) {
    throw new Error("Keypair file must be a 64-byte JSON array");
  }
  const keypair = Keypair.fromSecretKey(Uint8Array.from(parsed));
  parsed.fill(0);
  return keypair;
}

export interface KeeperGuardWallets {
  /** On-chain vault creator (deployer). */
  deployer: string;
  /** On-chain host treasury. */
  host: string;
  /** On-chain strategy/manager wallets. */
  strategy: string[];
  /** The keeper named on the DB definition row, when set. */
  namedKeeper: string | null;
}

/**
 * The keeper must be a dedicated hot wallet: never the vault deployer, host treasury or a
 * strategy/manager wallet, and — when the row names a keeper — it must be exactly that keeper.
 */
export function assertIndexKeeper(keeper: string, guards: KeeperGuardWallets): string {
  const k = address(keeper);
  if (k === address(guards.deployer)) throw new Error("Keeper must be a dedicated hot wallet, not the vault deployer");
  if (k === address(guards.host)) throw new Error("Keeper must be a dedicated hot wallet, not the host treasury");
  for (const strategy of guards.strategy) {
    if (k === address(strategy)) throw new Error("Keeper must be a dedicated hot wallet, not a strategy/manager wallet");
  }
  if (guards.namedKeeper && k !== address(guards.namedKeeper)) {
    throw new Error(`This index names keeper ${guards.namedKeeper}; the connected keypair ${k} is a different wallet`);
  }
  return k;
}

/**
 * Refuse clearly when the index has no created vault yet, the definition is unreadable/absent, or the
 * status carries no keeper targets. Returns the created-vault record ready for the on-chain read.
 */
export function assertCreatedVault(record: PersistedVaultDefinition | null, indexId: string): PersistedVaultDefinition {
  if (!record) throw new Error(`No InsiderIndex definition for ${indexId}: unreadable or does not exist`);
  if (record.status !== "CREATABLE") throw new Error(`${indexId} is ${record.status}, not CREATABLE — no keeper targets exist`);
  if (!record.vaultAddress || !record.shareMint) {
    throw new Error(`${indexId} has no created vault yet (vault_address/share_mint unset); create the vault before running the keeper`);
  }
  if (!keeperTargets(record).length) throw new Error(`${indexId} has no keeper targets in its DB record`);
  return record;
}

/** Raydium pool bindings from the persisted pool-ready legs. A leg missing pool/kind is refused. */
export function legBindings(legs: readonly PersistedVaultLeg[]): RaydiumPoolBinding[] {
  return legs.map((leg) => {
    if (!leg.pool || !leg.kind) throw new Error(`Leg ${leg.ticker} (${leg.mint}) has no tradable pool binding; refusing to trade around a leg with no pool`);
    if (leg.kind !== "raydium_clmm" && leg.kind !== "raydium_cpmm") throw new Error(`Leg ${leg.ticker} pool kind ${leg.kind} is not Raydium CLMM/CPMM`);
    return { mint: address(leg.mint), pool: address(leg.pool), kind: leg.kind };
  });
}

export interface IndexKeeperPlannedTrade {
  ticker: string | null;
  mint: string;
  onchainWeightBps: number | null;
  targetWeightBps: number;
  driftBps: number | null;
  action: "buy" | "sell" | "hold" | "add" | "unknown";
}

/** Weight-space plan the operator can read: buy underweight, sell overweight. No fabricated dollars. */
export function plannedTrades(drift: readonly KakuSanDriftRow[]): IndexKeeperPlannedTrade[] {
  return drift.map((row) => {
    let action: IndexKeeperPlannedTrade["action"] = "unknown";
    if (row.onchainWeightBps === null) action = row.targetWeightBps > 0 ? "add" : "unknown";
    else if (row.driftBps === null) action = "unknown";
    else if (row.driftBps > 0) action = "sell";
    else if (row.driftBps < 0) action = "buy";
    else action = "hold";
    return { ticker: row.ticker, mint: row.mint, onchainWeightBps: row.onchainWeightBps, targetWeightBps: row.targetWeightBps, driftBps: row.driftBps, action };
  });
}

export interface IndexKeeperObservation {
  vault: Vault;
  vaultAddress: string;
  shareMint: string;
  shareSupplyRaw: string;
  guards: KeeperGuardWallets;
  targets: { ticker: string; mint: string; targetWeightBps: number }[];
  drift: KakuSanDriftRow[];
  eligibility: KakuSanEligibility;
  intents: number;
  bindings: RaydiumPoolBinding[];
}

/**
 * Read the live vault for a created index definition and compute drift + eligibility with the shared
 * rule. On-chain identity (creator/host/managers) is read from the vault itself and returned as
 * keeper guards. Existing rebalance intents take priority over a fresh rebalance (never force one).
 */
export async function observeIndexVault(record: PersistedVaultDefinition, native: NativeVaultBuilders): Promise<IndexKeeperObservation> {
  assertNoPythEnvironment();
  if (native.network !== "mainnet-beta") throw new Error("Mainnet builder required");
  await native.assertNetwork();
  const vaultAddress = address(record.vaultAddress!);
  const shareMint = address(record.shareMint!);
  const account = await native.connection.getAccountInfo(new PublicKey(vaultAddress), "confirmed");
  if (!account || account.owner.toBase58() !== SYMMETRY_PROGRAM_ID) throw new Error("Missing or wrong-owner native vault on-chain");
  const vault = await native.sdk.fetchVault(vaultAddress);
  if (vault.ownAddress.toBase58() !== vaultAddress || vault.mint.toBase58() !== shareMint) throw new Error("On-chain vault identity does not match the DB record");
  // Include native cash/support slots for pricing AND residual balances, never for investment weights.
  const bindings = [...legBindings(record.vaultLegs), ...NATIVE_DEFAULT_BINDINGS];
  assertNativeTokenCap(vault.numTokens);
  assertRaydiumOnlyVault(vault, bindings);
  assertNativeSupportTargets(vault);
  const targets = keeperTargets(record);
  const drift = kakuSanDrift(vault, targets);
  const intents = await native.sdk.fetchVaultRebalanceIntents(vaultAddress);
  const eligibility = intents.length
    ? ({ required: null, reason: "Existing intents take priority over a new rebalance" } satisfies KakuSanEligibility)
    : await kakuSanRebalanceEligibility(vault, native.connection);
  const managers = readManagerWallets(vault);
  const mintSupply = await readShareSupply(native, vault);
  return {
    vault, vaultAddress, shareMint, shareSupplyRaw: mintSupply, drift, eligibility, targets, bindings,
    intents: intents.length,
    guards: { deployer: vault.settings.creator.toBase58(), host: vault.settings.host.toBase58(), strategy: managers, namedKeeper: record.keeper?.pubkey ?? null },
  };
}

function readManagerWallets(vault: Vault): string[] {
  const managers = (vault.settings as { managers?: { managers?: { toBase58(): string }[] } }).managers?.managers;
  if (!Array.isArray(managers)) return [];
  return managers.map((m) => m.toBase58());
}

async function readShareSupply(native: NativeVaultBuilders, vault: Vault): Promise<string> {
  try {
    const info = await native.connection.getTokenSupply(vault.mint, "confirmed");
    return info.value.amount;
  } catch {
    return "unknown";
  }
}

export interface IndexKeeperRebalancePlan {
  step: "prices" | "rebalance";
  eligible: boolean;
  reason: string;
  transactions: { txBase64: string }[];
}

/**
 * Build the execute plan when eligible: existing intents → update Raydium prices; otherwise, when the
 * shared eligibility rule requires it, a rebalance. Never forces a rebalance, never touches Hermes.
 */
export async function prepareIndexKeeperStep(
  observation: IndexKeeperObservation,
  keeper: string,
  native: NativeVaultBuilders,
  simulate = true,
): Promise<IndexKeeperRebalancePlan> {
  const keeperPk = address(keeper);
  if (hasUnreconciledSupportBalance(observation.vault)) return { step: "rebalance", eligible: false, reason: NATIVE_SUPPORT_BALANCE_REASON, transactions: [] };
  if (observation.intents > 0) {
    const intent = getRebalanceIntentPda(new PublicKey(observation.vaultAddress), new PublicKey(observation.vaultAddress)).toBase58();
    const { payload } = await native.priceUpdateFromVault(observation.vault, keeperPk, intent, observation.bindings);
    const transactions = payloadTransactions(payload, keeperPk);
    if (simulate) for (const tx of transactions) await simulateUnsigned(native.connection, tx.txBase64);
    return { step: "prices", eligible: true, reason: "Updating Raydium prices for the existing rebalance intent", transactions };
  }
  if (observation.eligibility.required !== true) {
    return { step: "rebalance", eligible: false, reason: observation.eligibility.reason, transactions: [] };
  }
  const payload = await native.sdk.rebalanceVaultTx({
    keeper: keeperPk, vault_mint: observation.shareMint, rebalance_slippage_bps: 100, per_trade_rebalance_slippage_bps: 50,
  });
  const transactions = payloadTransactions(payload, keeperPk);
  if (simulate) for (const tx of transactions) await simulateUnsigned(native.connection, tx.txBase64);
  return { step: "rebalance", eligible: true, reason: observation.eligibility.reason, transactions };
}

export function signKeeperTransactions(transactions: readonly { txBase64: string }[], keypair: Keypair): string[] {
  return transactions.map((tx) => {
    const parsed = VersionedTransaction.deserialize(Buffer.from(tx.txBase64, "base64"));
    parsed.sign([keypair]);
    return Buffer.from(parsed.serialize()).toString("base64");
  });
}

export async function submitKeeperSigned(
  input: { keeper: string; signedTransactions: readonly string[] },
  connection: Connection,
): Promise<{ signatures: string[]; slot: number | null }> {
  assertNoPythEnvironment();
  if (await connection.getGenesisHash() !== GENESIS["mainnet-beta"]) throw new Error("RPC genesis/network mismatch");
  const keeper = new PublicKey(address(input.keeper));
  const signatures: string[] = [];
  let slot: number | null = null;
  for (const signed of input.signedTransactions) {
    const tx = VersionedTransaction.deserialize(Buffer.from(signed, "base64"));
    if (tx.message.staticAccountKeys[0]?.toBase58() !== keeper.toBase58()) throw new Error("Signed transaction payer is not the keeper");
    const latest = await connection.getLatestBlockhash("confirmed");
    const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
    const confirmation = await connection.confirmTransaction({ signature, blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight }, "confirmed");
    if (confirmation.value.err) throw new Error(`Transaction ${signature} failed: ${JSON.stringify(confirmation.value.err)}`);
    signatures.push(signature);
    slot = confirmation.context.slot;
  }
  return { signatures, slot };
}

export type IndexKeeperMode = "dry-run" | "execute";

export interface IndexKeeperArgs {
  indexId: string;
  mode: IndexKeeperMode;
  keypair?: string;
}

/** Parse CLI args: index id required; dry-run default; `--execute` requires `--keypair PATH`. */
export function parseIndexKeeperArgs(argv: readonly string[]): IndexKeeperArgs {
  let indexId: string | undefined;
  let mode: IndexKeeperMode = "dry-run";
  let keypair: string | undefined;
  let sawDryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === undefined || next.startsWith("--")) throw new Error(`${flag} requires a value`);
      return next;
    };
    if (flag === "--dry-run") { sawDryRun = true; mode = "dry-run"; }
    else if (flag === "--execute") mode = "execute";
    else if (flag === "--index") indexId = value();
    else if (flag === "--keypair") keypair = value();
    else if (flag === "--keypath") throw new Error("Use --keypair PATH; the web app never holds a keeper keypair");
    else if (flag === "--vault" || flag === "--share-mint") throw new Error("This keeper reads the vault and share mint from the DB definition; pass --index <id>, not --vault/--share-mint");
    else if (flag === "--force-rebalance" || flag === "--force") throw new Error("Force-rebalance is not permitted");
    else if (indexId === undefined && !flag.startsWith("--")) indexId = flag;
    else throw new Error(`Unsupported argument ${flag}`);
  }
  if (!indexId) throw new Error("Usage: --index <indexId> [--dry-run] | --index <indexId> --execute --keypair <file>");
  if (sawDryRun && mode === "execute") throw new Error("Pass --dry-run or --execute, not both");
  if (mode === "execute" && !keypair) throw new Error("--execute requires --keypair PATH on the operator machine; fail-closed until that dedicated keeper key exists");
  if (mode === "dry-run" && keypair) throw new Error("--keypair is only valid with --execute");
  return { indexId, mode, ...(keypair ? { keypair } : {}) };
}

/** Injected seam so the orchestrator is testable offline (no DB, no RPC, no key, no broadcast). */
export interface IndexKeeperIo {
  readDefinition(indexId: string): Promise<PersistedVaultDefinition | null>;
  observe(record: PersistedVaultDefinition): Promise<IndexKeeperObservation>;
  loadKeypair(path: string): Keypair;
  prepare(observation: IndexKeeperObservation, keeper: string): Promise<IndexKeeperRebalancePlan>;
  sign(transactions: readonly { txBase64: string }[], keypair: Keypair): string[];
  submit(input: { keeper: string; signedTransactions: string[] }): Promise<{ signatures: string[]; slot: number | null }>;
  recordOutcome(indexId: string, result: Record<string, unknown>): Promise<void>;
  now?: () => string;
}

export interface IndexKeeperTickResult {
  schema: typeof INDEX_KEEPER_SCHEMA;
  mode: IndexKeeperMode;
  network: "mainnet-beta";
  indexId: string;
  name: string | null;
  vault: string;
  shareMint: string;
  keeper: string | null;
  targets: { ticker: string; mint: string; targetWeightBps: number }[];
  drift: KakuSanDriftRow[];
  plannedTrades: IndexKeeperPlannedTrade[];
  eligibility: KakuSanEligibility;
  broadcasts: number;
  signatures: string[];
  outcome: string;
  recordedAt: string;
}

/**
 * Run one DB-driven keeper tick.
 *
 * Dry run (default): compute drift, target/current weights, eligibility and planned trades; broadcast
 * nothing; record mode:"dry-run" (never a rebalance) onto the definition row.
 *
 * Execute: load the keeper key, refuse a wrong/deployer/host/strategy keeper, and only when the SAME
 * shared eligibility rule passes does it broadcast; otherwise it does nothing and says so. Records the
 * outcome either way.
 */
export async function runIndexKeeperTick(args: IndexKeeperArgs, io: IndexKeeperIo): Promise<IndexKeeperTickResult> {
  const now = io.now ?? (() => new Date().toISOString());
  const record = assertCreatedVault(await io.readDefinition(args.indexId), args.indexId);
  const observation = await io.observe(record);
  const drift = observation.drift;
  const trades = plannedTrades(drift);
  const base = {
    schema: INDEX_KEEPER_SCHEMA, network: "mainnet-beta" as const, indexId: args.indexId, name: record.name ?? null,
    vault: observation.vaultAddress, shareMint: observation.shareMint, targets: observation.targets,
    drift, plannedTrades: trades, eligibility: observation.eligibility,
  };

  if (args.mode === "dry-run") {
    const recordedAt = now();
    const result: IndexKeeperTickResult = { ...base, mode: "dry-run", keeper: null, broadcasts: 0, signatures: [], outcome: "dry-run", recordedAt };
    await io.recordOutcome(args.indexId, {
      mode: "dry-run", outcome: "dry-run", at: recordedAt, eligible: observation.eligibility.required, reason: observation.eligibility.reason,
      wouldTrade: trades.filter((t) => t.action === "buy" || t.action === "sell" || t.action === "add").length, broadcasts: 0,
    });
    return result;
  }

  // Execute: only now is a key loaded and the keeper identity enforced.
  const keypair = io.loadKeypair(args.keypair!);
  const keeper = assertIndexKeeper(keypair.publicKey.toBase58(), observation.guards);

  if (observation.eligibility.required !== true && observation.intents === 0) {
    const recordedAt = now();
    const result: IndexKeeperTickResult = { ...base, mode: "execute", keeper, broadcasts: 0, signatures: [], outcome: "skipped-not-eligible", recordedAt };
    await io.recordOutcome(args.indexId, { mode: "execute", outcome: "skipped-not-eligible", at: recordedAt, reason: observation.eligibility.reason, broadcasts: 0 });
    return result;
  }

  const plan = await io.prepare(observation, keeper);
  if (!plan.eligible || plan.transactions.length === 0) {
    const recordedAt = now();
    const result: IndexKeeperTickResult = { ...base, mode: "execute", keeper, broadcasts: 0, signatures: [], outcome: "skipped-not-eligible", recordedAt };
    await io.recordOutcome(args.indexId, { mode: "execute", outcome: "skipped-not-eligible", at: recordedAt, reason: plan.reason, broadcasts: 0 });
    return result;
  }

  const signed = io.sign(plan.transactions, keypair);
  const submitted = await io.submit({ keeper, signedTransactions: signed });
  const recordedAt = now();
  const outcome = plan.step === "prices" ? "prices-updated" : "rebalanced";
  const result: IndexKeeperTickResult = { ...base, mode: "execute", keeper, broadcasts: submitted.signatures.length, signatures: submitted.signatures, outcome, recordedAt };
  await io.recordOutcome(args.indexId, { mode: "execute", outcome, step: plan.step, at: recordedAt, signatures: submitted.signatures, slot: submitted.slot, broadcasts: submitted.signatures.length });
  return result;
}

/** Human-readable operator report. The captain runs this by hand and reads it before trusting it. */
export function formatKeeperReport(result: IndexKeeperTickResult): string {
  const lines: string[] = [];
  lines.push(`InsiderIndex keeper tick — ${result.indexId}${result.name ? ` (${result.name})` : ""}`);
  lines.push(`  mode:    ${result.mode.toUpperCase()}${result.mode === "dry-run" ? "  (no transaction is broadcast)" : ""}`);
  lines.push(`  network: ${result.network}`);
  lines.push(`  vault:   ${result.vault}`);
  lines.push(`  share:   ${result.shareMint}`);
  if (result.keeper) lines.push(`  keeper:  ${result.keeper}`);
  lines.push(`  eligible: ${result.eligibility.required === true ? "YES" : result.eligibility.required === false ? "no" : "unknown"} — ${result.eligibility.reason}`);
  lines.push("  weights (current bps -> target bps  [drift]):");
  for (const row of result.drift) {
    const cur = row.onchainWeightBps === null ? "absent" : String(row.onchainWeightBps);
    const drift = row.driftBps === null ? "n/a" : (row.driftBps > 0 ? `+${row.driftBps}` : String(row.driftBps));
    lines.push(`    ${(row.ticker ?? row.mint).padEnd(10)} ${cur.padStart(6)} -> ${String(row.targetWeightBps).padStart(6)}  [${drift}]`);
  }
  const trades = result.plannedTrades.filter((t) => t.action === "buy" || t.action === "sell" || t.action === "add");
  if (trades.length === 0) {
    lines.push("  planned trades: none (on target or not eligible)");
  } else {
    lines.push("  planned trades (weight-space, estimated; real amounts settle on-chain):");
    for (const t of trades) lines.push(`    ${t.action.toUpperCase().padEnd(4)} ${(t.ticker ?? t.mint)}  drift ${t.driftBps === null ? "n/a" : t.driftBps} bps`);
  }
  lines.push(`  outcome: ${result.outcome}  broadcasts: ${result.broadcasts}`);
  for (const sig of result.signatures) lines.push(`    signature: ${sig}`);
  lines.push(`  recorded at: ${result.recordedAt} (last_rebalance_result on the definition row)`);
  return lines.join("\n");
}

export { KAKU_SAN_NATIVE_TOKEN_CAP };
