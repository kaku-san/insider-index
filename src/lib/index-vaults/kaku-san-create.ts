import { verify } from "node:crypto";
import { Connection, PublicKey, VersionedTransaction } from "@solana/web3.js";
import type { FetchFn } from "@solana/web3.js";
import type { AddOrEditTokenInput, OracleInput, TxPayloadBatchSequence, Vault } from "@symmetry-hq/sdk";
import { OracleType } from "@symmetry-hq/sdk/dist/layouts/oracle.js";
import { getHeliusRpcUrl } from "../helius.ts";
import { address, sha256, weightsValid } from "./amounts.ts";
import { HOST_ENTRY_FEE_BPS, HOST_EXIT_FEE_BPS } from "./fees.ts";
import {
  durableCreateDraftJournal, type CreateDraftRpc, type CreateDraftState, type CreateDraftStore,
} from "./create-draft-store.ts";
import {
  KAKU_SAN, KAKU_SAN_ASSETS, KAKU_SAN_DEFAULT_SLOTS, KAKU_SAN_DEPLOYER, KAKU_SAN_INDEX_ID, KAKU_SAN_RAYDIUM_POOLS,
  assertKakuSanDeployer, type KakuSanAsset,
} from "./kaku-san.ts";
import { assertNoPythEnvironment, assertRaydiumOnlyToken } from "./raydium-oracles.ts";
import { GENESIS, NativeVaultBuilders, SYMMETRY_PROGRAM_ID } from "./symmetry-adapter.ts";
import { prepareCompositionTransactions, pendingCompositionIntents, compositionResumeStep } from "./composition-transactions.ts";
import { assertInstalledComposition, assertNativeDefaultPool, configuredDefaults, installedToken, nativeDefaultInput, NATIVE_DEFAULT_BINDINGS } from "./native-defaults.ts";

export function kakuSanOracleInput(asset: KakuSanAsset): OracleInput {
  return {
    oracle_type: "raydium_clmm",
    account_lut_id: 0,
    account_lut_index: 0,
    account: asset.pool,
    weight_bps: 10_000,
    is_required: true,
    conf_thresh_bps: 9999,
    volatility_thresh_bps: 9999,
    max_slippage_bps: 9999,
    min_liquidity: 0,
    staleness_thresh: 3600,
    staleness_conf_rate_bps: 0,
    token_decimals: asset.decimals,
    twap_seconds_ago: 30,
    twap_secondary_seconds_ago: 120,
    quote_token: "usdc",
  };
}

export function kakuSanTokenInput(asset: KakuSanAsset): AddOrEditTokenInput {
  const token: AddOrEditTokenInput = {
    token_mint: asset.mint,
    active: true,
    min_oracles_thresh: 1,
    min_conf_bps: 50,
    conf_thresh_bps: 200,
    conf_multiplier: 1,
    oracles: [kakuSanOracleInput(asset)],
  };
  assertRaydiumOnlyToken(token, KAKU_SAN_RAYDIUM_POOLS);
  return token;
}

/** Legacy API step name retained. Replace Pyth with valid Raydium inputs: inactive USDC,
 * native-required active WSOL support. The weights step gives BOTH defaults zero target. */
export const kakuSanDeactivateInput = nativeDefaultInput;

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

/** Fixed basket uses the SAME native support-slot contract as persisted index definitions. */
export function assertKakuSanComposition(vault: Pick<Vault, "composition" | "numTokens" | "lutPubkeys">): { activeMints: string[]; inactiveDefaults: string[] } {
  assertInstalledComposition(vault, KAKU_SAN_ASSETS.map(asset => ({ ...asset, token: kakuSanTokenInput(asset) })));
  const allocated = allocatedAssets(vault);
  return { activeMints: allocated.filter(isActiveAsset).map(a => a.mint.toBase58()),
    inactiveDefaults: allocated.filter(a => !isActiveAsset(a) && KAKU_SAN_DEFAULT_SLOTS.some(s => s.mint === a.mint.toBase58())).map(a => a.mint.toBase58()) };
}

const READ_METHODS = /^(get|simulateTransaction$|isBlockhashValid$)/;
export const KAKU_SAN_HEADERS = { "Cache-Control": "no-store" };
export const PREPARE_TIMEOUT_MS = 20_000;
const headers = KAKU_SAN_HEADERS;

export type KakuSanCreateStep = "create" | "deactivate-default" | "add-token" | "weights";
export type KakuSanKeeperStep = "prices" | "rebalance";
export type KakuSanStep = KakuSanCreateStep | KakuSanKeeperStep;
export interface KakuSanPreparedTx { txBase64: string; messageHash: string; payer: string }
export interface KakuSanPrepared {
  step: KakuSanStep;
  network: typeof KAKU_SAN.network;
  name: typeof KAKU_SAN.name;
  symbol: typeof KAKU_SAN.symbol;
  label: typeof KAKU_SAN.label;
  deployer: typeof KAKU_SAN.deployer;
  hostEntryFeeBps: number;
  hostExitFeeBps: number;
  basket: typeof KAKU_SAN_ASSETS;
  vault: string | null;
  shareMint: string | null;
  mint?: string;
  transactions: KakuSanPreparedTx[];
  eligible?: boolean;
  reason?: string;
  keeperNext?: string;
}
export interface KakuSanSubmitResult {
  step: KakuSanStep;
  vault: string;
  shareMint: string;
  signatures: string[];
  slot: number | null;
}
export interface KakuSanObservation {
  vault: string;
  shareMint: string;
  exists: boolean;
  activeMints: string[];
  inactiveDefaults: string[];
  configuredDefaults?: string[];
  installedMints?: string[];
  resumeStep?: { step: "weights" } | { step: "deactivate-default" | "add-token"; mint: string };
  pythRemaining: boolean;
  weightsSet: boolean;
  verified: boolean;
}

/** Durable identity of the one create attempt. Never a second createVaultTx while this is set.
 * `submitted` is latched true before the create transaction is ever broadcast (see submitKakuSanStep),
 * so a lost confirmation can never be mistaken for "never broadcast" by a later discard call. */
export interface KakuSanCreateDraft { vault: string; mint: string; transactions: KakuSanPreparedTx[]; submitted: boolean }

/** The durable, shared create-draft journal for the fixed Kaku San execution-test basket, keyed by
 *  `KAKU_SAN_INDEX_ID` so it lives in the same one-row-per-index store (migration 202609190001). */
export function kakuSanCreateJournal(rpc?: CreateDraftRpc): CreateDraftStore<CreateDraftState> {
  return durableCreateDraftJournal(KAKU_SAN_INDEX_ID, () => ({ indexId: KAKU_SAN_INDEX_ID, draft: null }), rpc);
}

const KAKU_SAN_STEPS: readonly KakuSanCreateStep[] = ["create", "deactivate-default", "add-token", "weights"];
function parseStep(value: unknown): KakuSanCreateStep {
  if (typeof value !== "string" || !KAKU_SAN_STEPS.includes(value as KakuSanCreateStep)) throw new Error("Unknown create step");
  return value as KakuSanCreateStep;
}

export function parseKakuSanPrepareRequest(body: unknown): { creator: string; step: KakuSanStep; vault?: string; shareMint?: string; mint?: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Create request required");
  const input = body as Record<string, unknown>;
  if (Object.keys(input).some(key => !["creator", "step", "vault", "shareMint", "mint"].includes(key))) throw new Error("Unexpected create field");
  if (typeof input.creator !== "string") throw new Error("Creator public key required");
  const creator = assertKakuSanDeployer(address(input.creator));
  if (input.step === "prices" || input.step === "rebalance") throw new Error("Rebalance is the local keeper CLI, not a wallet-signed web action");
  const step = input.step === undefined ? "create" : parseStep(input.step);
  if (step === "create") return { creator, step };
  if (typeof input.vault !== "string" || typeof input.shareMint !== "string") throw new Error("Existing vault and share mint required");
  const vault = address(input.vault);
  const shareMint = address(input.shareMint);
  if (step === "add-token" || step === "deactivate-default") {
    if (typeof input.mint !== "string") throw new Error("Token mint required");
    const mint = address(input.mint);
    if (step === "add-token" && !KAKU_SAN_ASSETS.some(asset => asset.mint === mint)) throw new Error("Mint is not in the Kaku San basket");
    if (step === "deactivate-default" && !KAKU_SAN_DEFAULT_SLOTS.some(slot => slot.mint === mint)) throw new Error("Mint is not a creation-time default slot");
    return { creator, step, vault, shareMint, mint };
  }
  return { creator, step, vault, shareMint };
}

export function parseKakuSanSubmitRequest(body: unknown): { creator: string; step: KakuSanStep; vault: string; shareMint: string; signedTransactions: string[] } {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Submit request required");
  const input = body as Record<string, unknown>;
  if (Object.keys(input).some(key => !["creator", "step", "vault", "shareMint", "signedTransactions"].includes(key))) throw new Error("Unexpected submit field");
  if (typeof input.creator !== "string") throw new Error("Creator public key required");
  const creator = assertKakuSanDeployer(address(input.creator));
  if (input.step === "prices" || input.step === "rebalance") throw new Error("Rebalance is the local keeper CLI, not a wallet-signed web action");
  const step = parseStep(input.step);
  if (typeof input.vault !== "string" || typeof input.shareMint !== "string") throw new Error("Vault and share mint required");
  if (!Array.isArray(input.signedTransactions) || input.signedTransactions.length === 0 || input.signedTransactions.length > 16 ||
      input.signedTransactions.some(tx => typeof tx !== "string" || tx.length === 0 || tx.length > 20_000)) throw new Error("Signed transactions required");
  return { creator, step, vault: address(input.vault), shareMint: address(input.shareMint), signedTransactions: input.signedTransactions };
}

export function parseKakuSanObserveRequest(body: unknown): { creator: string; vault: string; shareMint: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Observe request required");
  const input = body as Record<string, unknown>;
  if (Object.keys(input).some(key => !["creator", "vault", "shareMint"].includes(key))) throw new Error("Unexpected observe field");
  if (typeof input.creator !== "string") throw new Error("Creator public key required");
  if (typeof input.vault !== "string" || typeof input.shareMint !== "string") throw new Error("Existing vault and share mint required");
  return { creator: assertKakuSanDeployer(address(input.creator)), vault: address(input.vault), shareMint: address(input.shareMint) };
}

/** Discard is refused once the draft has been broadcast (or its vault is a real vault on-chain): never
 * abandon a create that may still land, and never abandon a created vault by mistake. Authorized by the
 * same Ed25519 deployer signature submitKakuSanStep enforces (assertSignedByDeployer), so a public-address
 * string match can no longer clear an operator's unbroadcast draft. */
export function parseKakuSanDiscardRequest(body: unknown): { creator: string; vault: string; shareMint: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Discard request required");
  const input = body as Record<string, unknown>;
  if (Object.keys(input).some(key => !["creator", "vault", "shareMint", "signedTransaction"].includes(key))) throw new Error("Unexpected discard field");
  if (typeof input.creator !== "string") throw new Error("Creator public key required");
  if (typeof input.vault !== "string" || typeof input.shareMint !== "string") throw new Error("Draft vault and share mint required");
  if (typeof input.signedTransaction !== "string" || input.signedTransaction.length === 0 || input.signedTransaction.length > 20_000) throw new Error("Signed discard authorization required");
  const creator = assertKakuSanDeployer(address(input.creator));
  assertSignedByDeployer(input.signedTransaction, creator);
  return { creator, vault: address(input.vault), shareMint: address(input.shareMint) };
}

/** Mainnet RPC only. Sends are permitted solely when broadcasting a wallet-signed transaction. Never a signer. */
export function kakuSanConnection(allowSend: boolean, url: string = getHeliusRpcUrl(), fetch?: FetchFn): Connection {
  if (/devnet/i.test(url)) throw new Error("Mainnet RPC only");
  return new Connection(url, { commitment: "confirmed", fetch, fetchMiddleware: (info, init, next) => {
    if (String(info) !== url) throw new Error("Pinned mainnet RPC only");
    const body = JSON.parse(String(init?.body));
    for (const call of Array.isArray(body) ? body : [body]) {
      const ok = typeof call.method === "string" && (READ_METHODS.test(call.method) || (allowSend && call.method === "sendTransaction"));
      if (!ok) throw new Error(`RPC method ${String(call.method)} is not permitted${allowSend ? "" : " in prepare"}`);
    }
    next(info, init);
  } });
}

export function kakuSanBuilders(allowSend: boolean, url?: string, fetch?: FetchFn): NativeVaultBuilders {
  return new NativeVaultBuilders(kakuSanConnection(allowSend, url, fetch), "mainnet-beta");
}

export function payloadTransactions(payload: TxPayloadBatchSequence, payer: string): KakuSanPreparedTx[] {
  const expected = address(payer);
  return payload.batches.flatMap(batch => batch.transactions.map(tx => {
    if (tx.payer !== expected) throw new Error("Transaction payer is not the approved deployer");
    const bytes = Buffer.from(tx.tx_b64, "base64");
    const parsed = VersionedTransaction.deserialize(bytes);
    if (parsed.message.staticAccountKeys[0]?.toBase58() !== expected) throw new Error("Transaction payer is not the approved deployer");
    if (parsed.signatures.some(signature => signature.some(byte => byte !== 0))) throw new Error("Prepare must return unsigned transactions");
    return { txBase64: tx.tx_b64, messageHash: sha256(parsed.message.serialize()), payer: expected };
  }));
}

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
export function assertSignedBy(txBase64: string, expected: string): VersionedTransaction {
  const creator = address(expected);
  const tx = VersionedTransaction.deserialize(Buffer.from(txBase64, "base64"));
  const payer = tx.message.staticAccountKeys[0];
  if (!payer || payer.toBase58() !== creator) throw new Error("Transaction payer is not the approved deployer");
  const signature = tx.signatures[0];
  if (!signature || signature.every(byte => byte === 0)) throw new Error("Transaction is unsigned");
  const key = Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(payer.toBytes())]);
  if (!verify(null, tx.message.serialize(), { key, format: "der", type: "spki" }, Buffer.from(signature))) throw new Error("Transaction signature is not the approved deployer");
  return tx;
}
export function assertSignedByDeployer(txBase64: string, expected: string = KAKU_SAN_DEPLOYER): VersionedTransaction {
  return assertSignedBy(txBase64, assertKakuSanDeployer(expected));
}

export async function simulateUnsigned(connection: Connection, txBase64: string): Promise<void> {
  const tx = VersionedTransaction.deserialize(Buffer.from(txBase64, "base64"));
  const result = await connection.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed" });
  if (result.value.err) throw new Error(`Simulation failed: ${JSON.stringify(result.value.err)}`);
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

function prepared(step: KakuSanStep, vault: string | null, shareMint: string | null, transactions: KakuSanPreparedTx[], mint?: string): KakuSanPrepared {
  return {
    step, network: KAKU_SAN.network, name: KAKU_SAN.name, symbol: KAKU_SAN.symbol, label: KAKU_SAN.label,
    deployer: KAKU_SAN.deployer, hostEntryFeeBps: HOST_ENTRY_FEE_BPS, hostExitFeeBps: HOST_EXIT_FEE_BPS,
    basket: KAKU_SAN_ASSETS, vault, shareMint, ...(mint ? { mint } : {}), transactions,
  };
}

/** Reuses the journaled draft's exact accounts/instructions; only the blockhash is refreshed so a stale
 * cached create never fails to simulate/sign. The vault/mint identity is never re-derived on retry. */
async function refreshedCreateTransaction(connection: Connection, tx: KakuSanPreparedTx): Promise<KakuSanPreparedTx> {
  const parsed = VersionedTransaction.deserialize(Buffer.from(tx.txBase64, "base64"));
  if (parsed.signatures.some(signature => signature.some(byte => byte !== 0))) throw new Error("Cached create draft is unexpectedly signed");
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  parsed.message.recentBlockhash = blockhash;
  return { txBase64: Buffer.from(parsed.serialize()).toString("base64"), messageHash: sha256(parsed.message.serialize()), payer: tx.payer };
}

export async function prepareKakuSanStep(input: ReturnType<typeof parseKakuSanPrepareRequest>, native: NativeVaultBuilders, simulate = true, journal: CreateDraftStore<CreateDraftState> = kakuSanCreateJournal()): Promise<KakuSanPrepared> {
  assertNoPythEnvironment();
  if (native.network !== "mainnet-beta") throw new Error("Mainnet builder required");
  await native.assertNetwork();
  const creator = assertKakuSanDeployer(input.creator);
  weightsValid([...KAKU_SAN_ASSETS]);
  if (input.step === "create") {
    return journal.update(async state => {
      if (state.draft) {
        const transactions = await Promise.all(state.draft.transactions.map(tx => refreshedCreateTransaction(native.connection, tx)));
        if (simulate) for (const tx of transactions) await simulateUnsigned(native.connection, tx.txBase64);
        return prepared("create", state.draft.vault, state.draft.mint, transactions);
      }
      // First and only createVaultTx call for this draft; the returned vault/mint is journaled below and
      // never re-derived from the native counter on a retry (README: "not generation of a second vault").
      const draft = await native.sdk.createVaultTx({
        creator, start_price: KAKU_SAN.startPrice, name: KAKU_SAN.name, symbol: KAKU_SAN.symbol,
        metadata_uri: KAKU_SAN.metadataUri, host_platform_params: hostParams(creator),
      });
      const transactions = payloadTransactions(draft, creator);
      if (simulate) for (const tx of transactions) await simulateUnsigned(native.connection, tx.txBase64);
      state.draft = { vault: draft.vault, mint: draft.mint, transactions, submitted: false };
      return prepared("create", draft.vault, draft.mint, transactions);
    });
  }
  const request = { vault: input.vault!, shareMint: input.shareMint!, creator,
    legs: KAKU_SAN_ASSETS.map(asset => ({ ...asset, token: kakuSanTokenInput(asset) })) };
  if (input.step === "deactivate-default") {
    const token = kakuSanDeactivateInput(input.mint!);
    await assertNativeDefaultPool(native.connection);
    const transactions = await prepareCompositionTransactions(native, { ...request, token },
      () => native.addToken({ vault: input.vault!, manager: creator }, token, NATIVE_DEFAULT_BINDINGS), simulate);
    return prepared("deactivate-default", input.vault!, input.shareMint!, transactions, token.token_mint);
  }
  if (input.step === "add-token") {
    const asset = KAKU_SAN_ASSETS.find(row => row.mint === input.mint);
    if (!asset) throw new Error("Mint is not in the Kaku San basket");
    const token = kakuSanTokenInput(asset);
    const transactions = await prepareCompositionTransactions(native, { ...request, token },
      () => native.addToken({ vault: input.vault!, manager: creator }, token, KAKU_SAN_RAYDIUM_POOLS), simulate);
    return prepared("add-token", input.vault!, input.shareMint!, transactions, asset.mint);
  }
  const transactions = await prepareCompositionTransactions(native, request,
    () => native.weights({ vault: input.vault!, manager: creator }, [...KAKU_SAN_ASSETS]), simulate);
  return prepared("weights", input.vault!, input.shareMint!, transactions);
}

/** Signature-status confirm: never wait on a freshly fetched blockhash that outlives the signed tx. */
export async function confirmWalletTransaction(connection: Connection, signature: string): Promise<number | null> {
  const confirmation = await connection.confirmTransaction(signature, "confirmed");
  if (confirmation.value.err) throw new Error(`Transaction ${signature} failed: ${JSON.stringify(confirmation.value.err)}`);
  return confirmation.context.slot;
}

/** Latches the journaled create draft as broadcast before the first sendRawTransaction. Once set, a lost
 * confirmation (dropped response, closed tab) can never look like "never broadcast" to discard; the
 * transaction may still land after this call returns, so discard must refuse from this point on.
 * Throws (never silently no-ops) if a concurrent discard already cleared or reused this draft slot, so
 * submitKakuSanStep aborts before ever broadcasting a create transaction whose journal entry is gone. */
export async function markKakuSanCreateBroadcast(vault: string, shareMint: string, journal: CreateDraftStore<CreateDraftState>): Promise<void> {
  await journal.update(state => {
    if (!state.draft || state.draft.vault !== vault || state.draft.mint !== shareMint) {
      throw new Error("Create draft was discarded before it could be broadcast; resume or recreate it");
    }
    state.draft.submitted = true;
  });
}

export async function submitKakuSanStep(input: ReturnType<typeof parseKakuSanSubmitRequest>, connection: Connection, journal: CreateDraftStore<CreateDraftState> = kakuSanCreateJournal()): Promise<KakuSanSubmitResult> {
  assertNoPythEnvironment();
  if (await connection.getGenesisHash() !== GENESIS["mainnet-beta"]) throw new Error("RPC genesis/network mismatch");
  const signatures: string[] = [];
  let slot: number | null = null;
  let broadcastMarked = false;
  for (const signed of input.signedTransactions) {
    const tx = assertSignedByDeployer(signed, input.creator);
    if (input.step === "create" && !broadcastMarked) {
      await markKakuSanCreateBroadcast(input.vault, input.shareMint, journal);
      broadcastMarked = true;
    }
    const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
    slot = await confirmWalletTransaction(connection, signature);
    signatures.push(signature);
  }
  return { step: input.step, vault: input.vault, shareMint: input.shareMint, signatures, slot };
}

function observation(vault: string, shareMint: string, exists: boolean, extra: Partial<KakuSanObservation> = {}): KakuSanObservation {
  return { vault, shareMint, exists, activeMints: [], inactiveDefaults: [], pythRemaining: false, weightsSet: false, verified: false, ...extra };
}

export async function observeKakuSanVault(input: { vault: string; shareMint: string }, native: NativeVaultBuilders): Promise<KakuSanObservation> {
  assertNoPythEnvironment();
  if (native.network !== "mainnet-beta") throw new Error("Mainnet builder required");
  await native.assertNetwork();
  const vault = address(input.vault);
  const shareMint = address(input.shareMint);
  const account = await native.connection.getAccountInfo(new PublicKey(vault), "confirmed");
  if (!account) return observation(vault, shareMint, false);
  if (account.owner.toBase58() !== SYMMETRY_PROGRAM_ID) throw new Error("Wrong native vault owner");
  const fetched = await native.sdk.fetchVault(vault);
  if (fetched.ownAddress.toBase58() !== vault || fetched.mint.toBase58() !== shareMint || fetched.settings.creator.toBase58() !== KAKU_SAN_DEPLOYER) throw new Error("Native vault identity mismatch");
  const allocated = allocatedAssets(fetched);
  const activeMints = allocated.filter(isActiveAsset).map(asset => asset.mint.toBase58());
  const inactiveDefaults = allocated.filter(asset => KAKU_SAN_DEFAULT_SLOTS.some(slot => slot.mint === asset.mint.toBase58()) && !isActiveAsset(asset)).map(asset => asset.mint.toBase58());
  const pythRemaining = allocated.some(asset => installedOracles(asset).some(oracle => oracle.oracleSettings.oracleType === OracleType.Pyth));
  const weightsSet = KAKU_SAN_ASSETS.every(asset => {
    const row = allocated.find(item => item.mint.toBase58() === asset.mint);
    return !!row && isActiveAsset(row) && row.weight === asset.targetWeightBps;
  });
  const pending = await pendingCompositionIntents(native, vault);
  const resumeStep = compositionResumeStep(pending, KAKU_SAN_ASSETS.map(a => a.mint));
  let verified = false;
  try { assertKakuSanComposition(fetched); verified = pending.length === 0 && fetched.settings.activeManagements.isZero(); }
  catch { /* Configuration not installed; never substitute financial readiness. */ }
  return observation(vault, shareMint, true, { activeMints, inactiveDefaults, pythRemaining, weightsSet, verified, resumeStep,
    configuredDefaults: configuredDefaults(fetched), installedMints: KAKU_SAN_ASSETS.filter(a => installedToken(fetched, kakuSanTokenInput(a))).map(a => a.mint) });
}

export async function withKakuSanTimeout<T>(work: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error("Kaku San request timed out");
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  try { return await Promise.race([work(controller.signal), timeout]); }
  finally { if (timer) clearTimeout(timer); if (!controller.signal.aborted) controller.abort(); }
}

export async function handleKakuSanPrepare(request: Request, nativeBuilder: (signal?: AbortSignal) => NativeVaultBuilders = () => kakuSanBuilders(false), timeoutMs = PREPARE_TIMEOUT_MS, journal: CreateDraftStore<CreateDraftState> = kakuSanCreateJournal()): Promise<Response> {
  let input: ReturnType<typeof parseKakuSanPrepareRequest>;
  try {
    const text = await request.text();
    if (text.length > 4096) return Response.json({ error: "Request too large" }, { status: 413, headers });
    input = parseKakuSanPrepareRequest(JSON.parse(text));
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Invalid Kaku San prepare request" }, { status: 400, headers });
  }
  try {
    const preparedStep = await withKakuSanTimeout(() => prepareKakuSanStep(input, nativeBuilder(), true, journal), timeoutMs);
    return Response.json(preparedStep, { status: 200, headers });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Kaku San prepare unavailable" }, { status: 503, headers });
  }
}

export async function handleKakuSanSubmit(request: Request, connectionBuilder: () => Connection = () => kakuSanConnection(true), journal: CreateDraftStore<CreateDraftState> = kakuSanCreateJournal()): Promise<Response> {
  let input: ReturnType<typeof parseKakuSanSubmitRequest>;
  try {
    const text = await request.text();
    if (text.length > 80_000) return Response.json({ error: "Request too large" }, { status: 413, headers });
    input = parseKakuSanSubmitRequest(JSON.parse(text));
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Invalid Kaku San submit request" }, { status: 400, headers });
  }
  try {
    // No timeout race: a 503 must not leave sendRawTransaction running in the background.
    const result = await submitKakuSanStep(input, connectionBuilder(), journal);
    return Response.json(result, { status: 200, headers });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Kaku San submit unavailable" }, { status: 503, headers });
  }
}

export async function handleKakuSanObserve(request: Request, nativeBuilder: () => NativeVaultBuilders = () => kakuSanBuilders(false), timeoutMs = PREPARE_TIMEOUT_MS): Promise<Response> {
  let input: ReturnType<typeof parseKakuSanObserveRequest>;
  try {
    const text = await request.text();
    if (text.length > 4096) return Response.json({ error: "Request too large" }, { status: 413, headers });
    input = parseKakuSanObserveRequest(JSON.parse(text));
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Invalid Kaku San observe request" }, { status: 400, headers });
  }
  try {
    const result = await withKakuSanTimeout(() => observeKakuSanVault(input, nativeBuilder()), timeoutMs);
    return Response.json(result, { status: 200, headers });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Kaku San observe unavailable" }, { status: 503, headers });
  }
}

/** Only clears a journaled draft that was never broadcast; refuses once submitKakuSanStep has sent the
 * create transaction (the durable `submitted` latch, immune to a lost confirmation) or once the draft's
 * vault is observably a real Symmetry vault on-chain (owned by the vault program, not merely funded). */
export async function discardKakuSanCreateDraft(input: ReturnType<typeof parseKakuSanDiscardRequest>, native: NativeVaultBuilders, journal: CreateDraftStore<CreateDraftState> = kakuSanCreateJournal()): Promise<{ discarded: boolean }> {
  assertNoPythEnvironment();
  if (native.network !== "mainnet-beta") throw new Error("Mainnet builder required");
  await native.assertNetwork();
  return journal.update(async state => {
    if (!state.draft) return { discarded: false };
    if (state.draft.vault !== input.vault || state.draft.mint !== input.shareMint) throw new Error("Discard target does not match the saved draft; resume it instead");
    if (state.draft.submitted) throw new Error("Draft create was already broadcast; it cannot be discarded, resume it instead");
    // Existence alone is not enough: an unrelated address can hold a stray balance at the derived vault
    // PDA without ever having been created by createVaultTx. Only a real Symmetry vault (owned by the
    // vault program) may refuse discard.
    const account = await native.connection.getAccountInfo(new PublicKey(state.draft.vault), "confirmed");
    if (account && account.owner.toBase58() === SYMMETRY_PROGRAM_ID) throw new Error("Draft vault already exists on-chain; it cannot be discarded");
    state.draft = null;
    return { discarded: true };
  });
}

export async function handleKakuSanDiscard(request: Request, nativeBuilder: () => NativeVaultBuilders = () => kakuSanBuilders(false), timeoutMs = PREPARE_TIMEOUT_MS, journal: CreateDraftStore<CreateDraftState> = kakuSanCreateJournal()): Promise<Response> {
  let input: ReturnType<typeof parseKakuSanDiscardRequest>;
  try {
    const text = await request.text();
    if (text.length > 4096) return Response.json({ error: "Request too large" }, { status: 413, headers });
    input = parseKakuSanDiscardRequest(JSON.parse(text));
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Invalid Kaku San discard request" }, { status: 400, headers });
  }
  try {
    const result = await withKakuSanTimeout(() => discardKakuSanCreateDraft(input, nativeBuilder(), journal), timeoutMs);
    return Response.json(result, { status: 200, headers });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Kaku San discard unavailable" }, { status: 503, headers });
  }
}

export function explorerAddress(pubkey: string): string {
  return `https://explorer.solana.com/address/${pubkey}`;
}
