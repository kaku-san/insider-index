import { NextResponse } from "next/server";
import { getHeliusRpcUrl, heliusConfigured } from "@/lib/helius";

export const dynamic = "force-dynamic";

/**
 * JSON-RPC pass-through so the browser (Privy wallet hooks, balance reads)
 * can use Helius without ever seeing HELIUS_API_KEY. Read-only + send methods
 * only; the server never signs.
 */
const ALLOWED_METHODS = new Set([
  "getAccountInfo",
  "getBalance",
  "getBlockHeight",
  "getEpochInfo",
  "getFeeForMessage",
  "getHealth",
  "getLatestBlockhash",
  "getMinimumBalanceForRentExemption",
  "getMultipleAccounts",
  "getRecentPrioritizationFees",
  "getSignatureStatuses",
  "getSlot",
  "getTokenAccountBalance",
  "getTokenAccountsByOwner",
  "getTokenSupply",
  "getTransaction",
  "getVersion",
  "isBlockhashValid",
  "sendTransaction",
  "simulateTransaction",
]);

type RpcCall = { jsonrpc?: string; id?: unknown; method?: string; params?: unknown };

function allowed(call: RpcCall): boolean {
  return typeof call.method === "string" && ALLOWED_METHODS.has(call.method);
}

export async function POST(request: Request) {
  let payload: RpcCall | RpcCall[];
  try {
    payload = (await request.json()) as RpcCall | RpcCall[];
  } catch {
    return NextResponse.json({ error: "Invalid JSON-RPC body." }, { status: 400 });
  }

  const calls = Array.isArray(payload) ? payload : [payload];
  if (calls.length === 0 || calls.length > 20 || !calls.every(allowed)) {
    return NextResponse.json({ error: "RPC method not allowed." }, { status: 403 });
  }

  const upstream = await fetch(getHeliusRpcUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    cache: "no-store",
    signal: AbortSignal.timeout(20_000),
  });

  const text = await upstream.text();
  return new NextResponse(text, {
    status: upstream.status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "X-Stocklana-Rpc": heliusConfigured() ? "helius" : "public",
    },
  });
}

export async function GET() {
  return NextResponse.json({ rpc: heliusConfigured() ? "helius" : "public" });
}
