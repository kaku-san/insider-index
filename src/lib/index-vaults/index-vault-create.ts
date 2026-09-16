/**
 * General admin creation of ANY persisted InsiderIndex vault definition.
 *
 * This is the generalisation of the fixed Kaku San execution-test path (`kaku-san-create.ts`, kept
 * intact and selectable): instead of the hardwired 5-stock basket constants, it builds the create →
 * deactivate-default → add-token → weights flow from the persisted vault definition record (Supabase
 * migration 202609160001 + 202609170002). Legs, mints, pools and target-weight bps come from that one
 * source of truth; the native leg cap is enforced by throwing, never truncating.
 *
 * Every existing safety is preserved by reusing the Kaku San primitives: only the approved deployer
 * may create/discard (`assertSignedByDeployer`), every mutating action requires the real Ed25519
 * deployer signature, the create draft is journaled, discard refuses once broadcast or once the vault
 * is a real Symmetry vault on-chain, the creation-time WSOL/USDC Pyth slots are deactivated after
 * create, and only Raydium oracles are installed. Creating a vault never opens deposits.
 */
import { Connection, PublicKey, VersionedTransaction } from "@solana/web3.js";
import type { AddOrEditTokenInput, OracleInput, Vault } from "@symmetry-hq/sdk";
import { OracleType } from "@symmetry-hq/sdk/dist/layouts/oracle.js";
import { address, sha256, weightsValid } from "./amounts.ts";
import { HOST_ENTRY_FEE_BPS, HOST_EXIT_FEE_BPS } from "./fees.ts";
import { Journal } from "./journal.ts";
import {
  KAKU_SAN_DEFAULT_SLOTS, KAKU_SAN_DEPLOYER, KAKU_SAN_METADATA_URI, KAKU_SAN_START_PRICE,
  assertKakuSanDeployer,
} from "./kaku-san.ts";
import {
  KAKU_SAN_HEADERS, PREPARE_TIMEOUT_MS, assertSignedByDeployer, confirmWalletTransaction, explorerAddress,
  kakuSanBuilders, kakuSanConnection, kakuSanDeactivateInput, payloadTransactions, simulateUnsigned,
  withKakuSanTimeout, type KakuSanPreparedTx,
} from "./kaku-san-create.ts";
import { assertNativeTokenCap, KAKU_SAN_NATIVE_TOKEN_CAP } from "./kaku-san-rebalance.ts";
import { assertNoPythEnvironment, assertRaydiumOnlyToken, type RaydiumOracleKind } from "./raydium-oracles.ts";
import { GENESIS, NativeVaultBuilders, SYMMETRY_PROGRAM_ID } from "./symmetry-adapter.ts";
import { readVaultDefinition, readVaultDefinitions, writeVaultCreation, type PersistedVaultDefinition, type PersistedVaultLeg, type VaultDefinitionSummary } from "./vault-definition-store.ts";
import { createServiceSupabase } from "../supabase.ts";

/** The approved deployer is the same wallet the execution-test path enforces; the server holds no key. */
export const INDEX_VAULT_DEPLOYER = KAKU_SAN_DEPLOYER;
export const INDEX_VAULT_NETWORK = "mainnet-beta" as const;
const MIN_LEGS = 2;
const RAYDIUM_KINDS: readonly RaydiumOracleKind[] = ["raydium_clmm", "raydium_cpmm"];
const headers = KAKU_SAN_HEADERS;

function raydiumKind(kind: string): RaydiumOracleKind {
  if (!RAYDIUM_KINDS.includes(kind as RaydiumOracleKind)) {
    throw new Error(`ORACLE_KIND_FORBIDDEN: ${String(kind)} (Raydium CLMM/CPMM only)`);
  }
  return kind as RaydiumOracleKind;
}

export type CreatableIndexLeg = {
  ticker: string;
  mint: string;
  decimals: number;
  pool: string;
  kind: RaydiumOracleKind;
  targetWeightBps: number;
  tvlUsd: number | null;
};
/** A validated, creatable index vault: the persisted definition reduced to what create needs, with
 *  every guard already applied (deployer, CREATABLE, pool-ready legs, cap, integer bps summing 10000). */
export type CreatableIndexVault = {
  indexId: string;
  name: string;
  symbol: string;
  network: typeof INDEX_VAULT_NETWORK;
  deployer: string;
  startPrice: string;
  metadataUri: string;
  hostEntryFeeBps: number;
  hostExitFeeBps: number;
  nativeTokenCap: number;
  legs: CreatableIndexLeg[];
};

/** Refuse clearly rather than half-create: an unreadable definition, a non-CREATABLE status, no
 *  pool-ready legs, a cap violation or malformed weights each stop here with a specific message. */
export function assertCreatableDefinition(record: PersistedVaultDefinition | null, indexId: string): CreatableIndexVault {
  if (!record) throw new Error(`Index definition ${indexId} is not readable; nothing to create.`);
  if (record.indexId !== indexId) throw new Error("Index definition identity mismatch; refusing to create.");
  if ((record.network ?? INDEX_VAULT_NETWORK) !== INDEX_VAULT_NETWORK) throw new Error(`Index ${indexId} is not a ${INDEX_VAULT_NETWORK} definition.`);
  if (record.status !== "CREATABLE") {
    const reasons = (record.blockedReasons ?? []).join(", ");
    throw new Error(`Index ${indexId} is ${record.status}${reasons ? ` (${reasons})` : ""}; not creatable.`);
  }
  const raw = Array.isArray(record.vaultLegs) ? record.vaultLegs : [];
  if (raw.length === 0) throw new Error(`Index ${indexId} has no pool-ready legs; nothing to create.`);
  // The cap is enforced by throwing, never by truncating the book to fit.
  assertNativeTokenCap(raw.length, "vault legs");
  if (raw.length < MIN_LEGS) throw new Error(`Index ${indexId} has ${raw.length} pool-ready leg(s); a vault needs at least ${MIN_LEGS}.`);
  const legs: CreatableIndexLeg[] = raw.map((leg: PersistedVaultLeg) => {
    if (!leg || typeof leg.mint !== "string" || typeof leg.pool !== "string") throw new Error(`Index ${indexId} has a malformed leg; refusing to create.`);
    if (!Number.isInteger(leg.decimals) || leg.decimals < 0) throw new Error(`Index ${indexId} leg ${leg.ticker} has invalid decimals.`);
    if (!Number.isInteger(leg.targetWeightBps) || leg.targetWeightBps <= 0) throw new Error(`Index ${indexId} leg ${leg.ticker} has invalid target weight.`);
    return {
      ticker: leg.ticker, mint: address(leg.mint), decimals: leg.decimals,
      pool: address(leg.pool), kind: raydiumKind(leg.kind), targetWeightBps: leg.targetWeightBps,
      tvlUsd: typeof leg.tvlUsd === "number" ? leg.tvlUsd : null,
    };
  });
  // Integer bps must sum to exactly 10000 across the pool-ready legs; never silently re-weighted here.
  weightsValid(legs.map(l => ({ mint: l.mint, targetWeightBps: l.targetWeightBps })));
  return {
    indexId: record.indexId,
    name: record.name,
    symbol: record.symbol,
    network: INDEX_VAULT_NETWORK,
    deployer: INDEX_VAULT_DEPLOYER,
    startPrice: KAKU_SAN_START_PRICE,
    metadataUri: KAKU_SAN_METADATA_URI,
    hostEntryFeeBps: HOST_ENTRY_FEE_BPS,
    hostExitFeeBps: HOST_EXIT_FEE_BPS,
    nativeTokenCap: KAKU_SAN_NATIVE_TOKEN_CAP,
    legs,
  };
}

export function indexOracleInput(leg: CreatableIndexLeg): OracleInput {
  return {
    oracle_type: leg.kind,
    account_lut_id: 0,
    account_lut_index: 0,
    account: leg.pool,
    weight_bps: 10_000,
    is_required: true,
    conf_thresh_bps: 9999,
    volatility_thresh_bps: 9999,
    max_slippage_bps: 9999,
    min_liquidity: 0,
    staleness_thresh: 3600,
    staleness_conf_rate_bps: 0,
    token_decimals: leg.decimals,
    twap_seconds_ago: 30,
    twap_secondary_seconds_ago: 120,
    quote_token: "usdc",
  };
}

export function indexTokenInput(leg: CreatableIndexLeg): AddOrEditTokenInput {
  const token: AddOrEditTokenInput = {
    token_mint: leg.mint,
    active: true,
    min_oracles_thresh: 1,
    min_conf_bps: 50,
    conf_thresh_bps: 200,
    conf_multiplier: 1,
    oracles: [indexOracleInput(leg)],
  };
  // Reuse the Raydium-only guard against this leg's own documented pool binding: rejects Pyth, a
  // pool mismatch, or a lookalike account. Never invents a pool.
  assertRaydiumOnlyToken(token, [{ mint: leg.mint, pool: leg.pool, kind: leg.kind }]);
  return token;
}

export type IndexCreateStep = "create" | "deactivate-default" | "add-token" | "weights";
export interface IndexPrepared {
  step: IndexCreateStep;
  indexId: string;
  network: typeof INDEX_VAULT_NETWORK;
  name: string;
  symbol: string;
  deployer: string;
  hostEntryFeeBps: number;
  hostExitFeeBps: number;
  legs: CreatableIndexLeg[];
  vault: string | null;
  shareMint: string | null;
  mint?: string;
  transactions: KakuSanPreparedTx[];
}
export interface IndexSubmitResult {
  step: IndexCreateStep;
  indexId: string;
  vault: string;
  shareMint: string;
  signatures: string[];
  slot: number | null;
  writtenBack: boolean;
}
export interface IndexObservation {
  indexId: string;
  vault: string;
  shareMint: string;
  exists: boolean;
  activeMints: string[];
  inactiveDefaults: string[];
  pythRemaining: boolean;
  weightsSet: boolean;
  verified: boolean;
}

export interface IndexCreateDraft { vault: string; mint: string; transactions: KakuSanPreparedTx[]; submitted: boolean }
interface IndexCreateJournalState { indexId: string | null; draft: IndexCreateDraft | null }

function journalPathFor(indexId: string): string {
  const safe = indexId.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 96) || "index";
  return `.data/index-vaults/index-create-${safe}.json`;
}
export function indexCreateJournal(indexId: string, path: string = journalPathFor(indexId)): Journal<IndexCreateJournalState> {
  return new Journal<IndexCreateJournalState>(path, () => ({ indexId: null, draft: null }));
}

const STEPS: readonly IndexCreateStep[] = ["create", "deactivate-default", "add-token", "weights"];
function parseStep(value: unknown): IndexCreateStep {
  if (typeof value !== "string" || !STEPS.includes(value as IndexCreateStep)) throw new Error("Unknown create step");
  return value as IndexCreateStep;
}

export function parseIndexPrepareRequest(body: unknown): { creator: string; indexId: string; step: IndexCreateStep; vault?: string; shareMint?: string; mint?: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Create request required");
  const input = body as Record<string, unknown>;
  if (Object.keys(input).some(key => !["creator", "indexId", "step", "vault", "shareMint", "mint"].includes(key))) throw new Error("Unexpected create field");
  if (typeof input.creator !== "string") throw new Error("Creator public key required");
  if (typeof input.indexId !== "string" || input.indexId.length === 0 || input.indexId.length > 128) throw new Error("Index id required");
  const creator = assertKakuSanDeployer(address(input.creator));
  const step = input.step === undefined ? "create" : parseStep(input.step);
  if (step === "create") return { creator, indexId: input.indexId, step };
  if (typeof input.vault !== "string" || typeof input.shareMint !== "string") throw new Error("Existing vault and share mint required");
  const vault = address(input.vault);
  const shareMint = address(input.shareMint);
  if (step === "add-token" || step === "deactivate-default") {
    if (typeof input.mint !== "string") throw new Error("Token mint required");
    return { creator, indexId: input.indexId, step, vault, shareMint, mint: address(input.mint) };
  }
  return { creator, indexId: input.indexId, step, vault, shareMint };
}

export function parseIndexSubmitRequest(body: unknown): { creator: string; indexId: string; step: IndexCreateStep; vault: string; shareMint: string; signedTransactions: string[] } {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Submit request required");
  const input = body as Record<string, unknown>;
  if (Object.keys(input).some(key => !["creator", "indexId", "step", "vault", "shareMint", "signedTransactions"].includes(key))) throw new Error("Unexpected submit field");
  if (typeof input.creator !== "string") throw new Error("Creator public key required");
  if (typeof input.indexId !== "string" || input.indexId.length === 0 || input.indexId.length > 128) throw new Error("Index id required");
  const creator = assertKakuSanDeployer(address(input.creator));
  const step = parseStep(input.step);
  if (typeof input.vault !== "string" || typeof input.shareMint !== "string") throw new Error("Vault and share mint required");
  if (!Array.isArray(input.signedTransactions) || input.signedTransactions.length === 0 || input.signedTransactions.length > 16 ||
      input.signedTransactions.some(tx => typeof tx !== "string" || tx.length === 0 || tx.length > 20_000)) throw new Error("Signed transactions required");
  return { creator, indexId: input.indexId, step, vault: address(input.vault), shareMint: address(input.shareMint), signedTransactions: input.signedTransactions };
}

export function parseIndexObserveRequest(body: unknown): { creator: string; indexId: string; vault: string; shareMint: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Observe request required");
  const input = body as Record<string, unknown>;
  if (Object.keys(input).some(key => !["creator", "indexId", "vault", "shareMint"].includes(key))) throw new Error("Unexpected observe field");
  if (typeof input.creator !== "string") throw new Error("Creator public key required");
  if (typeof input.indexId !== "string") throw new Error("Index id required");
  if (typeof input.vault !== "string" || typeof input.shareMint !== "string") throw new Error("Existing vault and share mint required");
  return { creator: assertKakuSanDeployer(address(input.creator)), indexId: input.indexId, vault: address(input.vault), shareMint: address(input.shareMint) };
}

export function parseIndexDiscardRequest(body: unknown): { creator: string; indexId: string; vault: string; shareMint: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Discard request required");
  const input = body as Record<string, unknown>;
  if (Object.keys(input).some(key => !["creator", "indexId", "vault", "shareMint", "signedTransaction"].includes(key))) throw new Error("Unexpected discard field");
  if (typeof input.creator !== "string") throw new Error("Creator public key required");
  if (typeof input.indexId !== "string") throw new Error("Index id required");
  if (typeof input.vault !== "string" || typeof input.shareMint !== "string") throw new Error("Draft vault and share mint required");
  if (typeof input.signedTransaction !== "string" || input.signedTransaction.length === 0 || input.signedTransaction.length > 20_000) throw new Error("Signed discard authorization required");
  const creator = assertKakuSanDeployer(address(input.creator));
  assertSignedByDeployer(input.signedTransaction, creator);
  return { creator, indexId: input.indexId, vault: address(input.vault), shareMint: address(input.shareMint) };
}

/** Definition loader: reads the persisted record from Supabase by default; tests inject a fake. */
export type DefinitionLoader = (indexId: string) => Promise<PersistedVaultDefinition | null>;
export type CreationWriteBack = (indexId: string, vault: string, shareMint: string, receipt: Record<string, unknown>) => Promise<void>;

export function supabaseDefinitionLoader(): DefinitionLoader {
  return async (indexId: string) => {
    const db = createServiceSupabase();
    if (!db) throw new Error("Service-role Supabase is required to read index vault definitions.");
    return readVaultDefinition(db, indexId);
  };
}
export function supabaseCreationWriteBack(): CreationWriteBack {
  return async (indexId, vault, shareMint, receipt) => {
    const db = createServiceSupabase();
    if (!db) throw new Error("Service-role Supabase is required to record the created vault.");
    await writeVaultCreation(db, indexId, vault, shareMint, receipt);
  };
}

function allocatedAssets(vault: Pick<Vault, "composition" | "numTokens">) {
  return vault.composition.slice(0, vault.numTokens);
}
function isActiveAsset(asset: { active: number | boolean }): boolean {
  return asset.active === true || asset.active === 1;
}
function installedOracles(asset: Vault["composition"][number]) {
  const aggregator = asset.oracleAggregator;
  return aggregator.oracles.slice(0, aggregator.numOracles);
}

function prepared(step: IndexCreateStep, def: CreatableIndexVault, vault: string | null, shareMint: string | null, transactions: KakuSanPreparedTx[], mint?: string): IndexPrepared {
  return {
    step, indexId: def.indexId, network: def.network, name: def.name, symbol: def.symbol, deployer: def.deployer,
    hostEntryFeeBps: def.hostEntryFeeBps, hostExitFeeBps: def.hostExitFeeBps, legs: def.legs,
    vault, shareMint, ...(mint ? { mint } : {}), transactions,
  };
}

function hostParams(creator: string) {
  return {
    host_pubkey: creator,
    host_deposit_fee_bps: HOST_ENTRY_FEE_BPS,
    host_withdraw_fee_bps: HOST_EXIT_FEE_BPS,
    host_management_fee_bps: 0,
    host_performance_fee_bps: 0,
  };
}

async function refreshedCreateTransaction(connection: Connection, tx: KakuSanPreparedTx): Promise<KakuSanPreparedTx> {
  const parsed = VersionedTransaction.deserialize(Buffer.from(tx.txBase64, "base64"));
  if (parsed.signatures.some(signature => signature.some(byte => byte !== 0))) throw new Error("Cached create draft is unexpectedly signed");
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  parsed.message.recentBlockhash = blockhash;
  return { txBase64: Buffer.from(parsed.serialize()).toString("base64"), messageHash: sha256(parsed.message.serialize()), payer: tx.payer };
}

export async function prepareIndexStep(
  input: ReturnType<typeof parseIndexPrepareRequest>,
  native: NativeVaultBuilders,
  loadDefinition: DefinitionLoader,
  simulate = true,
  journal: Journal<IndexCreateJournalState> = indexCreateJournal(input.indexId),
): Promise<IndexPrepared> {
  assertNoPythEnvironment();
  if (native.network !== "mainnet-beta") throw new Error("Mainnet builder required");
  await native.assertNetwork();
  const creator = assertKakuSanDeployer(input.creator);
  const def = assertCreatableDefinition(await loadDefinition(input.indexId), input.indexId);

  if (input.step === "create") {
    return journal.update(async state => {
      if (state.draft && state.indexId === def.indexId) {
        const transactions = await Promise.all(state.draft.transactions.map(tx => refreshedCreateTransaction(native.connection, tx)));
        if (simulate) for (const tx of transactions) await simulateUnsigned(native.connection, tx.txBase64);
        return prepared("create", def, state.draft.vault, state.draft.mint, transactions);
      }
      if (state.draft && state.indexId !== def.indexId) throw new Error(`A create draft for ${state.indexId} is already journaled here; resume or discard it first.`);
      const draft = await native.sdk.createVaultTx({
        creator, start_price: def.startPrice, name: def.name, symbol: def.symbol,
        metadata_uri: def.metadataUri, host_platform_params: hostParams(creator),
      });
      const transactions = payloadTransactions(draft, creator);
      if (simulate) for (const tx of transactions) await simulateUnsigned(native.connection, tx.txBase64);
      state.indexId = def.indexId;
      state.draft = { vault: draft.vault, mint: draft.mint, transactions, submitted: false };
      return prepared("create", def, draft.vault, draft.mint, transactions);
    });
  }
  if (input.step === "deactivate-default") {
    const token = kakuSanDeactivateInput(input.mint!);
    const payload = await native.sdk.addOrEditTokenTx({ vault: input.vault!, manager: creator }, token);
    const transactions = payloadTransactions(payload, creator);
    if (simulate) for (const tx of transactions) await simulateUnsigned(native.connection, tx.txBase64);
    return prepared("deactivate-default", def, input.vault!, input.shareMint!, transactions, token.token_mint);
  }
  if (input.step === "add-token") {
    const leg = def.legs.find(l => l.mint === input.mint);
    if (!leg) throw new Error(`Mint ${input.mint} is not a pool-ready leg of ${def.indexId}.`);
    const token = indexTokenInput(leg);
    const payload = await native.addToken({ vault: input.vault!, manager: creator }, token, [{ mint: leg.mint, pool: leg.pool, kind: leg.kind }]);
    const transactions = payloadTransactions(payload, creator);
    if (simulate) for (const tx of transactions) await simulateUnsigned(native.connection, tx.txBase64);
    return prepared("add-token", def, input.vault!, input.shareMint!, transactions, leg.mint);
  }
  const payload = await native.weights({ vault: input.vault!, manager: creator }, def.legs.map(leg => ({ mint: leg.mint, targetWeightBps: leg.targetWeightBps })));
  const transactions = payloadTransactions(payload, creator);
  if (simulate) for (const tx of transactions) await simulateUnsigned(native.connection, tx.txBase64);
  return prepared("weights", def, input.vault!, input.shareMint!, transactions);
}

/** Latch the journaled create draft as broadcast before the first send. Throws if a concurrent discard
 *  already cleared it, so submit aborts before ever broadcasting a create whose journal entry is gone. */
export async function markIndexCreateBroadcast(indexId: string, vault: string, shareMint: string, journal: Journal<IndexCreateJournalState>): Promise<void> {
  await journal.update(state => {
    if (!state.draft || state.indexId !== indexId || state.draft.vault !== vault || state.draft.mint !== shareMint) {
      throw new Error("Create draft was discarded before it could be broadcast; resume or recreate it");
    }
    state.draft.submitted = true;
  });
}

export async function submitIndexStep(
  input: ReturnType<typeof parseIndexSubmitRequest>,
  connection: Connection,
  writeBack: CreationWriteBack,
  journal: Journal<IndexCreateJournalState> = indexCreateJournal(input.indexId),
): Promise<IndexSubmitResult> {
  assertNoPythEnvironment();
  if (await connection.getGenesisHash() !== GENESIS["mainnet-beta"]) throw new Error("RPC genesis/network mismatch");
  const signatures: string[] = [];
  let slot: number | null = null;
  let broadcastMarked = false;
  for (const signed of input.signedTransactions) {
    const tx = assertSignedByDeployer(signed, input.creator);
    if (input.step === "create" && !broadcastMarked) {
      await markIndexCreateBroadcast(input.indexId, input.vault, input.shareMint, journal);
      broadcastMarked = true;
    }
    const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
    slot = await confirmWalletTransaction(connection, signature);
    signatures.push(signature);
  }
  // One source of truth: after a confirmed create, write the vault + share mint back onto the record.
  // The write-back never opens deposits; the public Invest release flag stays authoritative on top.
  let writtenBack = false;
  if (input.step === "create") {
    await recordIndexCreation(writeBack, { indexId: input.indexId, vault: input.vault, shareMint: input.shareMint, creator: input.creator, signatures, slot });
    writtenBack = true;
  }
  return { step: input.step, indexId: input.indexId, vault: input.vault, shareMint: input.shareMint, signatures, slot, writtenBack };
}

/** Persist the confirmed create back onto the definition record: vault address + share mint + receipt.
 *  Recorded as one source of truth for the keeper and the site; never toggles any deposits/funds flag. */
export async function recordIndexCreation(
  writeBack: CreationWriteBack,
  input: { indexId: string; vault: string; shareMint: string; creator: string; signatures: string[]; slot: number | null },
): Promise<void> {
  await writeBack(input.indexId, input.vault, input.shareMint, {
    signatures: input.signatures, slot: input.slot, network: INDEX_VAULT_NETWORK,
    deployer: input.creator, createdAt: new Date().toISOString(),
  });
}

function observationOf(indexId: string, vault: string, shareMint: string, exists: boolean, extra: Partial<IndexObservation> = {}): IndexObservation {
  return { indexId, vault, shareMint, exists, activeMints: [], inactiveDefaults: [], pythRemaining: false, weightsSet: false, verified: false, ...extra };
}

export async function observeIndexVault(input: { indexId: string; vault: string; shareMint: string }, native: NativeVaultBuilders, loadDefinition: DefinitionLoader): Promise<IndexObservation> {
  assertNoPythEnvironment();
  if (native.network !== "mainnet-beta") throw new Error("Mainnet builder required");
  await native.assertNetwork();
  const def = assertCreatableDefinition(await loadDefinition(input.indexId), input.indexId);
  const vault = address(input.vault);
  const shareMint = address(input.shareMint);
  const account = await native.connection.getAccountInfo(new PublicKey(vault), "confirmed");
  if (!account) return observationOf(def.indexId, vault, shareMint, false);
  const fetched = await native.sdk.fetchVault(vault);
  if (fetched.ownAddress.toBase58() !== vault || fetched.mint.toBase58() !== shareMint) throw new Error("Native vault identity mismatch");
  const allocated = allocatedAssets(fetched);
  const legMints = new Set(def.legs.map(l => l.mint));
  const activeMints = allocated.filter(isActiveAsset).map(asset => asset.mint.toBase58());
  const inactiveDefaults = allocated.filter(asset => KAKU_SAN_DEFAULT_SLOTS.some(slot => slot.mint === asset.mint.toBase58()) && !isActiveAsset(asset)).map(asset => asset.mint.toBase58());
  const pythRemaining = allocated.some(asset => installedOracles(asset).some(oracle => oracle.oracleSettings.oracleType === OracleType.Pyth));
  const weightsSet = def.legs.every(leg => {
    const row = allocated.find(item => item.mint.toBase58() === leg.mint);
    return !!row && isActiveAsset(row) && Number(row.weight) === leg.targetWeightBps;
  });
  const activeLegMints = activeMints.filter(mint => legMints.has(mint));
  const defaultsClear = KAKU_SAN_DEFAULT_SLOTS.every(slot => {
    const row = allocated.find(item => item.mint.toBase58() === slot.mint);
    return !row || !isActiveAsset(row);
  });
  const verified = !pythRemaining && weightsSet && defaultsClear && activeLegMints.length === def.legs.length && def.legs.every(l => legMints.has(l.mint) && activeLegMints.includes(l.mint)) && activeMints.every(mint => legMints.has(mint));
  return observationOf(def.indexId, vault, shareMint, true, { activeMints, inactiveDefaults, pythRemaining, weightsSet, verified });
}

export async function discardIndexCreateDraft(
  input: ReturnType<typeof parseIndexDiscardRequest>,
  native: NativeVaultBuilders,
  journal: Journal<IndexCreateJournalState> = indexCreateJournal(input.indexId),
): Promise<{ discarded: boolean }> {
  assertNoPythEnvironment();
  if (native.network !== "mainnet-beta") throw new Error("Mainnet builder required");
  await native.assertNetwork();
  return journal.update(async state => {
    if (!state.draft) return { discarded: false };
    if (state.indexId !== input.indexId) throw new Error("Discard target does not match the journaled index; resume it instead");
    if (state.draft.vault !== input.vault || state.draft.mint !== input.shareMint) throw new Error("Discard target does not match the saved draft; resume it instead");
    if (state.draft.submitted) throw new Error("Draft create was already broadcast; it cannot be discarded, resume it instead");
    const account = await native.connection.getAccountInfo(new PublicKey(state.draft.vault), "confirmed");
    if (account && account.owner.toBase58() === SYMMETRY_PROGRAM_ID) throw new Error("Draft vault already exists on-chain; it cannot be discarded");
    state.draft = null;
    state.indexId = null;
    return { discarded: true };
  });
}

// ---- HTTP handlers ---------------------------------------------------------

export async function handleIndexPrepare(
  request: Request,
  nativeBuilder: () => NativeVaultBuilders = () => kakuSanBuilders(false),
  loadDefinition: DefinitionLoader = supabaseDefinitionLoader(),
  timeoutMs = PREPARE_TIMEOUT_MS,
): Promise<Response> {
  let input: ReturnType<typeof parseIndexPrepareRequest>;
  try {
    const text = await request.text();
    if (text.length > 4096) return Response.json({ error: "Request too large" }, { status: 413, headers });
    input = parseIndexPrepareRequest(JSON.parse(text));
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Invalid index prepare request" }, { status: 400, headers });
  }
  try {
    const step = await withKakuSanTimeout(() => prepareIndexStep(input, nativeBuilder(), loadDefinition, true, indexCreateJournal(input.indexId)), timeoutMs);
    return Response.json(step, { status: 200, headers });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Index prepare unavailable" }, { status: 503, headers });
  }
}

export async function handleIndexSubmit(
  request: Request,
  connectionBuilder: () => Connection = () => kakuSanConnection(true),
  writeBack: CreationWriteBack = supabaseCreationWriteBack(),
): Promise<Response> {
  let input: ReturnType<typeof parseIndexSubmitRequest>;
  try {
    const text = await request.text();
    if (text.length > 80_000) return Response.json({ error: "Request too large" }, { status: 413, headers });
    input = parseIndexSubmitRequest(JSON.parse(text));
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Invalid index submit request" }, { status: 400, headers });
  }
  try {
    const result = await submitIndexStep(input, connectionBuilder(), writeBack, indexCreateJournal(input.indexId));
    return Response.json(result, { status: 200, headers });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Index submit unavailable" }, { status: 503, headers });
  }
}

export async function handleIndexObserve(
  request: Request,
  nativeBuilder: () => NativeVaultBuilders = () => kakuSanBuilders(false),
  loadDefinition: DefinitionLoader = supabaseDefinitionLoader(),
  timeoutMs = PREPARE_TIMEOUT_MS,
): Promise<Response> {
  let input: ReturnType<typeof parseIndexObserveRequest>;
  try {
    const text = await request.text();
    if (text.length > 4096) return Response.json({ error: "Request too large" }, { status: 413, headers });
    input = parseIndexObserveRequest(JSON.parse(text));
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Invalid index observe request" }, { status: 400, headers });
  }
  try {
    const result = await withKakuSanTimeout(() => observeIndexVault(input, nativeBuilder(), loadDefinition), timeoutMs);
    return Response.json(result, { status: 200, headers });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Index observe unavailable" }, { status: 503, headers });
  }
}

export async function handleIndexDiscard(
  request: Request,
  nativeBuilder: () => NativeVaultBuilders = () => kakuSanBuilders(false),
  timeoutMs = PREPARE_TIMEOUT_MS,
): Promise<Response> {
  let input: ReturnType<typeof parseIndexDiscardRequest>;
  try {
    const text = await request.text();
    if (text.length > 4096) return Response.json({ error: "Request too large" }, { status: 413, headers });
    input = parseIndexDiscardRequest(JSON.parse(text));
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Invalid index discard request" }, { status: 400, headers });
  }
  try {
    const result = await withKakuSanTimeout(() => discardIndexCreateDraft(input, nativeBuilder(), indexCreateJournal(input.indexId)), timeoutMs);
    return Response.json(result, { status: 200, headers });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Index discard unavailable" }, { status: 503, headers });
  }
}

// ---- Pre-sign preview + selector list -------------------------------------

/** Whole-book (catalog) coverage vs tradable (pool-ready) coverage, read live from the definition.
 *  Never re-weighted here: these are the recorded numbers the operator sees before they sign. */
export interface IndexPreviewCoverage {
  tickerCount: number;
  mappedLegCount: number;
  vaultReadyLegCount: number;
  mappableByWeightBps: number;
  unmappedByWeightBps: number;
  poolReadyOfMappedBps: number;
}
export interface IndexPreview {
  indexId: string;
  name: string;
  symbol: string;
  network: string;
  kind: string;
  status: string;
  creatable: boolean;
  refuseReason: string | null;
  depositsEnabled: boolean;
  depositReason: string | null;
  deployer: string;
  hostEntryFeeBps: number;
  hostExitFeeBps: number;
  nativeTokenCap: number;
  legCount: number;
  legs: CreatableIndexLeg[];
  coverage: IndexPreviewCoverage;
  poolExcludedLegs: { ticker: string; mint: string; reason: string }[];
  vaultAddress: string | null;
  shareMint: string | null;
  bookSource: string | null;
}

function coverageOf(record: PersistedVaultDefinition): IndexPreviewCoverage {
  const c = (record.coverage ?? {}) as Record<string, unknown>;
  const num = (key: string): number => (typeof c[key] === "number" ? (c[key] as number) : 0);
  return {
    tickerCount: num("tickerCount"),
    mappedLegCount: num("mappedLegCount"),
    vaultReadyLegCount: num("vaultReadyLegCount"),
    mappableByWeightBps: num("mappableByWeightBps"),
    unmappedByWeightBps: num("unmappedByWeightBps"),
    poolReadyOfMappedBps: num("poolReadyOfMappedBps"),
  };
}

/** Build the reviewable preview. A non-creatable/unreadable definition is still previewable so the
 *  operator sees exactly why it is refused; `creatable` gates the Create button, not the fetch. */
export function buildIndexPreview(record: PersistedVaultDefinition | null, indexId: string): IndexPreview {
  if (!record) throw new Error(`Index definition ${indexId} is not readable.`);
  let creatable = false;
  let refuseReason: string | null = null;
  let legs: CreatableIndexLeg[] = [];
  let cap = typeof record.nativeTokenCap === "number" ? record.nativeTokenCap : KAKU_SAN_NATIVE_TOKEN_CAP;
  try {
    const def = assertCreatableDefinition(record, indexId);
    creatable = true;
    legs = def.legs;
    cap = def.nativeTokenCap;
  } catch (error) {
    refuseReason = error instanceof Error ? error.message : "Not creatable.";
    legs = (Array.isArray(record.vaultLegs) ? record.vaultLegs : []).map((leg) => ({
      ticker: leg.ticker, mint: leg.mint, decimals: leg.decimals, pool: leg.pool,
      kind: (RAYDIUM_KINDS.includes(leg.kind as RaydiumOracleKind) ? (leg.kind as RaydiumOracleKind) : "raydium_clmm"),
      targetWeightBps: leg.targetWeightBps, tvlUsd: typeof leg.tvlUsd === "number" ? leg.tvlUsd : null,
    }));
  }
  return {
    indexId: record.indexId,
    name: record.name,
    symbol: record.symbol,
    network: record.network ?? INDEX_VAULT_NETWORK,
    kind: record.kind ?? "person",
    status: record.status,
    creatable,
    refuseReason,
    // The per-vault deposit gate is closed by default and never opened by creation; surfaced so the
    // operator sees plainly that creating this vault does not enable deposits.
    depositsEnabled: record.depositsEnabled === true,
    depositReason: typeof record.depositReason === "string" ? record.depositReason : null,
    deployer: INDEX_VAULT_DEPLOYER,
    hostEntryFeeBps: typeof record.hostEntryFeeBps === "number" ? record.hostEntryFeeBps : HOST_ENTRY_FEE_BPS,
    hostExitFeeBps: typeof record.hostExitFeeBps === "number" ? record.hostExitFeeBps : HOST_EXIT_FEE_BPS,
    nativeTokenCap: cap,
    legCount: legs.length,
    legs,
    coverage: coverageOf(record),
    poolExcludedLegs: Array.isArray(record.poolExcludedLegs) ? record.poolExcludedLegs : [],
    vaultAddress: record.vaultAddress,
    shareMint: record.shareMint,
    bookSource: record.bookSource,
  };
}

export function parseIndexPreviewRequest(body: unknown): { creator: string; indexId: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Preview request required");
  const input = body as Record<string, unknown>;
  if (Object.keys(input).some(key => !["creator", "indexId"].includes(key))) throw new Error("Unexpected preview field");
  if (typeof input.creator !== "string") throw new Error("Creator public key required");
  if (typeof input.indexId !== "string" || input.indexId.length === 0 || input.indexId.length > 128) throw new Error("Index id required");
  return { creator: assertKakuSanDeployer(address(input.creator)), indexId: input.indexId };
}

export function parseIndexListRequest(body: unknown): { creator: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("List request required");
  const input = body as Record<string, unknown>;
  if (Object.keys(input).some(key => key !== "creator")) throw new Error("Unexpected list field");
  if (typeof input.creator !== "string") throw new Error("Creator public key required");
  return { creator: assertKakuSanDeployer(address(input.creator)) };
}

export type DefinitionListLoader = () => Promise<VaultDefinitionSummary[]>;
export function supabaseDefinitionListLoader(): DefinitionListLoader {
  return async () => {
    const db = createServiceSupabase();
    if (!db) throw new Error("Service-role Supabase is required to list index vault definitions.");
    return readVaultDefinitions(db);
  };
}

export async function handleIndexPreview(
  request: Request,
  loadDefinition: DefinitionLoader = supabaseDefinitionLoader(),
): Promise<Response> {
  let input: ReturnType<typeof parseIndexPreviewRequest>;
  try {
    const text = await request.text();
    if (text.length > 4096) return Response.json({ error: "Request too large" }, { status: 413, headers });
    input = parseIndexPreviewRequest(JSON.parse(text));
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Invalid index preview request" }, { status: 400, headers });
  }
  try {
    const preview = buildIndexPreview(await loadDefinition(input.indexId), input.indexId);
    return Response.json(preview, { status: 200, headers });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Index preview unavailable" }, { status: 503, headers });
  }
}

export async function handleIndexList(
  request: Request,
  listDefinitions: DefinitionListLoader = supabaseDefinitionListLoader(),
): Promise<Response> {
  try {
    const text = await request.text();
    if (text.length > 4096) return Response.json({ error: "Request too large" }, { status: 413, headers });
    parseIndexListRequest(JSON.parse(text));
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Invalid index list request" }, { status: 400, headers });
  }
  try {
    const definitions = await listDefinitions();
    return Response.json({ definitions }, { status: 200, headers });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Index list unavailable" }, { status: 503, headers });
  }
}

export { explorerAddress };
