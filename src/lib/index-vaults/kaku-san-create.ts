import { verify } from "node:crypto";
import { Connection, VersionedTransaction } from "@solana/web3.js";
import type { FetchFn } from "@solana/web3.js";
import type { AddOrEditTokenInput, OracleInput, TxPayloadBatchSequence } from "@symmetry-hq/sdk";
import { getHeliusRpcUrl } from "../helius.ts";
import { address, sha256, weightsValid } from "./amounts.ts";
import { HOST_ENTRY_FEE_BPS, HOST_EXIT_FEE_BPS } from "./fees.ts";
import { KAKU_SAN, KAKU_SAN_ASSETS, KAKU_SAN_DEPLOYER, KAKU_SAN_RAYDIUM_POOLS, assertKakuSanDeployer, type KakuSanAsset } from "./kaku-san.ts";
import { assertNoPythEnvironment, assertRaydiumOnlyToken } from "./raydium-oracles.ts";
import { GENESIS, NativeVaultBuilders } from "./symmetry-adapter.ts";

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

const READ_METHODS = /^(get|simulateTransaction$|isBlockhashValid$)/;
export const KAKU_SAN_HEADERS = { "Cache-Control": "no-store" };
export const PREPARE_TIMEOUT_MS = 20_000;
const headers = KAKU_SAN_HEADERS;

export type KakuSanCreateStep = "create" | "add-token" | "weights";
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

export function parseKakuSanPrepareRequest(body: unknown): { creator: string; step: KakuSanStep; vault?: string; shareMint?: string; mint?: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Create request required");
  const input = body as Record<string, unknown>;
  if (Object.keys(input).some(key => !["creator", "step", "vault", "shareMint", "mint"].includes(key))) throw new Error("Unexpected create field");
  if (typeof input.creator !== "string") throw new Error("Creator public key required");
  const creator = assertKakuSanDeployer(address(input.creator));
  const step = input.step === undefined ? "create" : input.step;
  if (step === "prices" || step === "rebalance") throw new Error("Rebalance is the local keeper CLI, not a wallet-signed web action");
  if (step !== "create" && step !== "add-token" && step !== "weights") throw new Error("Unknown create step");
  if (step === "create") return { creator, step };
  if (typeof input.vault !== "string" || typeof input.shareMint !== "string") throw new Error("Existing vault and share mint required");
  const vault = address(input.vault);
  const shareMint = address(input.shareMint);
  if (step === "add-token") {
    if (typeof input.mint !== "string") throw new Error("Token mint required");
    const mint = address(input.mint);
    if (!KAKU_SAN_ASSETS.some(asset => asset.mint === mint)) throw new Error("Mint is not in the Kaku San basket");
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
  const step = input.step;
  if (step === "prices" || step === "rebalance") throw new Error("Rebalance is the local keeper CLI, not a wallet-signed web action");
  if (step !== "create" && step !== "add-token" && step !== "weights") throw new Error("Unknown create step");
  if (typeof input.vault !== "string" || typeof input.shareMint !== "string") throw new Error("Vault and share mint required");
  if (!Array.isArray(input.signedTransactions) || input.signedTransactions.length === 0 || input.signedTransactions.length > 16 ||
      input.signedTransactions.some(tx => typeof tx !== "string" || tx.length === 0 || tx.length > 20_000)) throw new Error("Signed transactions required");
  return { creator, step, vault: address(input.vault), shareMint: address(input.shareMint), signedTransactions: input.signedTransactions };
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

export async function prepareKakuSanStep(input: ReturnType<typeof parseKakuSanPrepareRequest>, native: NativeVaultBuilders, simulate = true): Promise<KakuSanPrepared> {
  assertNoPythEnvironment();
  if (native.network !== "mainnet-beta") throw new Error("Mainnet builder required");
  await native.assertNetwork();
  const creator = assertKakuSanDeployer(input.creator);
  weightsValid([...KAKU_SAN_ASSETS]);
  if (input.step === "create") {
    const draft = await native.sdk.createVaultTx({
      creator, start_price: KAKU_SAN.startPrice, name: KAKU_SAN.name, symbol: KAKU_SAN.symbol,
      metadata_uri: KAKU_SAN.metadataUri, host_platform_params: hostParams(creator),
    });
    const transactions = payloadTransactions(draft, creator);
    if (simulate) for (const tx of transactions) await simulateUnsigned(native.connection, tx.txBase64);
    return prepared("create", draft.vault, draft.mint, transactions);
  }
  if (input.step === "add-token") {
    const asset = KAKU_SAN_ASSETS.find(row => row.mint === input.mint);
    if (!asset) throw new Error("Mint is not in the Kaku San basket");
    const token = kakuSanTokenInput(asset);
    const payload = await native.addToken({ vault: input.vault!, manager: creator }, token, KAKU_SAN_RAYDIUM_POOLS);
    const transactions = payloadTransactions(payload, creator);
    if (simulate) for (const tx of transactions) await simulateUnsigned(native.connection, tx.txBase64);
    return prepared("add-token", input.vault!, input.shareMint!, transactions, asset.mint);
  }
  const payload = await native.weights({ vault: input.vault!, manager: creator }, KAKU_SAN_ASSETS.map(asset => ({ mint: asset.mint, targetWeightBps: asset.targetWeightBps })));
  const transactions = payloadTransactions(payload, creator);
  if (simulate) for (const tx of transactions) await simulateUnsigned(native.connection, tx.txBase64);
  return prepared("weights", input.vault!, input.shareMint!, transactions);
}

export async function submitKakuSanStep(input: ReturnType<typeof parseKakuSanSubmitRequest>, connection: Connection): Promise<KakuSanSubmitResult> {
  assertNoPythEnvironment();
  if (await connection.getGenesisHash() !== GENESIS["mainnet-beta"]) throw new Error("RPC genesis/network mismatch");
  const signatures: string[] = [];
  let slot: number | null = null;
  for (const signed of input.signedTransactions) {
    const tx = assertSignedByDeployer(signed, input.creator);
    const latest = await connection.getLatestBlockhash("confirmed");
    const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
    const confirmation = await connection.confirmTransaction({ signature, blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight }, "confirmed");
    if (confirmation.value.err) throw new Error(`Transaction ${signature} failed: ${JSON.stringify(confirmation.value.err)}`);
    signatures.push(signature);
    slot = confirmation.context.slot;
  }
  return { step: input.step, vault: input.vault, shareMint: input.shareMint, signatures, slot };
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

export async function handleKakuSanPrepare(request: Request, nativeBuilder: (signal?: AbortSignal) => NativeVaultBuilders = () => kakuSanBuilders(false), timeoutMs = PREPARE_TIMEOUT_MS): Promise<Response> {
  let input: ReturnType<typeof parseKakuSanPrepareRequest>;
  try {
    const text = await request.text();
    if (text.length > 4096) return Response.json({ error: "Request too large" }, { status: 413, headers });
    input = parseKakuSanPrepareRequest(JSON.parse(text));
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Invalid Kaku San prepare request" }, { status: 400, headers });
  }
  try {
    const preparedStep = await withKakuSanTimeout(() => prepareKakuSanStep(input, nativeBuilder()), timeoutMs);
    return Response.json(preparedStep, { status: 200, headers });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Kaku San prepare unavailable" }, { status: 503, headers });
  }
}

export async function handleKakuSanSubmit(request: Request, connectionBuilder: () => Connection = () => kakuSanConnection(true), timeoutMs = PREPARE_TIMEOUT_MS): Promise<Response> {
  let input: ReturnType<typeof parseKakuSanSubmitRequest>;
  try {
    const text = await request.text();
    if (text.length > 80_000) return Response.json({ error: "Request too large" }, { status: 413, headers });
    input = parseKakuSanSubmitRequest(JSON.parse(text));
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Invalid Kaku San submit request" }, { status: 400, headers });
  }
  try {
    const result = await withKakuSanTimeout(() => submitKakuSanStep(input, connectionBuilder()), timeoutMs);
    return Response.json(result, { status: 200, headers });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Kaku San submit unavailable" }, { status: 503, headers });
  }
}

export function explorerAddress(pubkey: string): string {
  return `https://explorer.solana.com/address/${pubkey}`;
}
