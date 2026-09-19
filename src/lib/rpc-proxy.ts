import { PublicKey } from "@solana/web3.js";
import { VAULTS_V3_PROGRAM_ID } from "@symmetry-hq/sdk/dist/constants.js";
import { RebalanceIntentLayout } from "@symmetry-hq/sdk/dist/layouts/intents/rebalanceIntent.js";

// Preserve the existing proxy contract, including user-signed relay. New cycle capabilities
// below are reads only, constrained to the shapes used by the independent wallet validator.
const EXISTING_METHODS = new Set([
  "getAccountInfo", "getBalance", "getBlockHeight", "getEpochInfo", "getFeeForMessage",
  "getHealth", "getLatestBlockhash", "getMinimumBalanceForRentExemption", "getMultipleAccounts",
  "getRecentPrioritizationFees", "getSignatureStatuses", "getSlot", "getTokenAccountBalance",
  "getTokenAccountsByOwner", "getTokenSupply", "getTransaction", "getVersion",
  "isBlockhashValid", "sendTransaction", "simulateTransaction",
]);
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const keysOnly = (v: Record<string, unknown>, keys: readonly string[]) => Object.keys(v).every(k => keys.includes(k));
const slot = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
function address(v: unknown): boolean {
  if (typeof v !== "string" || v.length > 44) return false;
  try { return new PublicKey(v).toBase58() === v; } catch { return false; }
}
const signature = (v: unknown) => typeof v === "string" && /^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(v);

function allowed(call: unknown): boolean {
  if (!object(call) || typeof call.method !== "string") return false;
  if (EXISTING_METHODS.has(call.method)) return true;
  const p = call.params;
  if (call.method === "getGenesisHash") return p === undefined || (Array.isArray(p) && p.length === 0);
  if (!Array.isArray(p)) return false;
  if (call.method === "getBlockTime") return p.length === 1 && slot(p[0]);
  if (p.length !== 2 || !object(p[1])) return false;
  const c = p[1];
  if (call.method === "getBlock") {
    // getBlockSignatures uses getBlock on the wire. Do not open full-block downloads.
    return slot(p[0]) && keysOnly(c, ["commitment", "transactionDetails", "rewards"])
      && c.commitment === "finalized" && c.transactionDetails === "signatures" && c.rewards === false;
  }
  if (call.method === "getSignaturesForAddress") {
    return address(p[0]) && keysOnly(c, ["commitment", "limit", "before", "minContextSlot"])
      && c.commitment === "finalized" && Number.isInteger(c.limit) && Number(c.limit) >= 1 && Number(c.limit) <= 100
      && slot(c.minContextSlot) && (c.before === undefined || signature(c.before));
  }
  if (call.method === "getProgramAccounts") {
    if (p[0] !== VAULTS_V3_PROGRAM_ID.toBase58() || !keysOnly(c, ["commitment", "encoding", "filters"])
      || c.commitment !== "confirmed" || c.encoding !== "base64" || !Array.isArray(c.filters) || c.filters.length !== 2) return false;
    const sizes = c.filters.filter(f => object(f) && Object.keys(f).length === 1 && f.dataSize === RebalanceIntentLayout.span + 8);
    const vaults = c.filters.filter(f => object(f) && Object.keys(f).length === 1 && object(f.memcmp)
      && keysOnly(f.memcmp, ["offset", "bytes", "encoding"]) && f.memcmp.offset === 8 && address(f.memcmp.bytes)
      && (f.memcmp.encoding === undefined || f.memcmp.encoding === "base58"));
    return sizes.length === 1 && vaults.length === 1;
  }
  return false;
}

/** The upstream URL comes only from server configuration, never the request. Injectable transport
 * permits offline HTTP-contract tests; no key, environment lookup, signing or database access here. */
export async function handleRpcProxy(request: Request, options: {
  upstream: () => string;
  provider: "helius" | "public";
  fetcher?: typeof fetch;
}): Promise<Response> {
  const headers = { "Cache-Control": "no-store" };
  let payload: unknown;
  try { payload = await request.json(); }
  catch { return Response.json({ error: "Invalid JSON-RPC body." }, { status: 400, headers }); }
  const calls = Array.isArray(payload) ? payload : [payload];
  if (!calls.length || calls.length > 20 || !calls.every(allowed)) {
    return Response.json({ error: "RPC method not allowed." }, { status: 403, headers });
  }
  try {
    const url = options.upstream();
    const upstream = await (options.fetcher ?? fetch)(url, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
      cache: "no-store", redirect: "error", signal: AbortSignal.timeout(20_000),
    });
    const text = await upstream.text(), key = new URL(url).searchParams.get("api-key");
    // An upstream diagnostic must not echo its credential or private request URL into the browser.
    if (text.includes(url) || (key && text.includes(key))) throw new Error("UPSTREAM_CREDENTIAL_ECHO");
    return new Response(text, { status: upstream.status, headers: {
      ...headers, "Content-Type": "application/json", "X-Stocklana-Rpc": options.provider,
    } });
  } catch {
    return Response.json({ error: "RPC upstream unavailable." }, { status: 502, headers });
  }
}
