import { NextResponse } from "next/server";
import { getHeliusRpcUrl, heliusConfigured } from "@/lib/helius";
import { handleRpcProxy } from "@/lib/rpc-proxy";

export const dynamic = "force-dynamic";

/** Existing same-origin RPC: credentials stay server-side; the server never signs.
 * Cycle validation adds only scoped discovery and finalized history reads. */
export async function POST(request: Request) {
  return handleRpcProxy(request, {
    upstream: getHeliusRpcUrl,
    provider: heliusConfigured() ? "helius" : "public",
  });
}

export async function GET() {
  return NextResponse.json({ rpc: heliusConfigured() ? "helius" : "public" });
}
