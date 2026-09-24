import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";

// Preserve user-signed relay and bounded reads. Program-wide scans are not exposed.
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
const signature = (v: unknown) => {
  if (typeof v !== "string") return false;
  try { return bs58.decode(v).length === 64; } catch { return false; }
};

function validEnvelope(call: Record<string, unknown>): boolean {
  if (call.jsonrpc !== "2.0") return false;
  if (Object.hasOwn(call, "id") && call.id !== null
    && (typeof call.id !== "string" && (typeof call.id !== "number" || !Number.isFinite(call.id)))) return false;
  return call.params === undefined || Array.isArray(call.params);
}

function allowed(call: unknown): boolean {
  if (!object(call) || !validEnvelope(call) || typeof call.method !== "string") return false;
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
