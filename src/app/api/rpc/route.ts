import { NextResponse } from "next/server";
import { getHeliusRpcUrl, getRpcProvider } from "@/lib/helius";
import { handleRpcProxy } from "@/lib/rpc-proxy";
import { rpcMaxMultipleAccounts } from "@/lib/rpc-multiple-accounts";

export const dynamic = "force-dynamic";

/** Existing same-origin RPC: credentials stay server-side; the server never signs.
 * Cycle validation adds only scoped discovery and finalized history reads. */
export async function POST(request: Request) {
  return handleRpcProxy(request, {
    upstream: getHeliusRpcUrl,
    provider: getRpcProvider(),
    maxMultipleAccounts: rpcMaxMultipleAccounts(),
  });
}

export async function GET() {
  return NextResponse.json({ rpc: getRpcProvider() });
}
