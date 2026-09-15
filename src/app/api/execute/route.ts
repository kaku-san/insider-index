import { NextResponse } from "next/server";
import { resolveBuyableMint } from "@/lib/allowlist";
import { JupiterError, executeJupiterOrder } from "@/lib/jupiter";
import { assertPositionStoreReady, PositionStoreError, recordPosition } from "@/lib/positions";
import { loadCopyOrder, verifyCopyOrder } from "@/lib/copy-orders";
import { jupiterMode } from "@/lib/runtime";

export const dynamic = "force-dynamic";
const atomic = (value: string | undefined) => typeof value === "string" && /^\d+$/.test(value) ? value : null;

export async function POST(request: Request) {
  let body;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON." }, { status: 400 }); }
  if (!body || ![body.signedTransaction, body.requestId, body.wallet].every(v => typeof v === "string" && v.length > 0)) {
    return NextResponse.json({ error: "signedTransaction, requestId and wallet are required." }, { status: 400 });
  }

  try {
    const order = await loadCopyOrder(body.requestId);
    if (!verifyCopyOrder(order, body.wallet, body.signedTransaction) || (order.stub && jupiterMode() === "live")) {
      return NextResponse.json({ error: "Unknown, expired or mismatched order. Request a fresh quote." }, { status: 400 });
    }
    // Never trust client ticker/mint/amount metadata to manufacture a durable receipt.
    const token = await resolveBuyableMint(order.mint);
    if (!token) return NextResponse.json({ error: "Copy blocked: mint is not in the Solana catalog." }, { status: 403 });
    await assertPositionStoreReady();
    const result = await executeJupiterOrder({ signedTransaction: body.signedTransaction, requestId: order.request_id });
    if (result.status !== "Success" || !result.signature) {
      return NextResponse.json({ error: "Jupiter execution not confirmed. Check your wallet before retrying.", result }, { status: 502 });
    }
    try {
      const position = await recordPosition({
        wallet: order.wallet, disclosureId: order.disclosure_id, ticker: order.ticker,
        tokenSymbol: order.token_symbol, venue: order.venue, mint: order.mint, side: order.side,
        inputAmountRaw: atomic(result.inputAmountResult), outputAmountRaw: atomic(result.outputAmountResult),
        inputDecimals: order.side === "buy" ? 6 : order.token_decimals,
        outputDecimals: order.side === "buy" ? order.token_decimals : 6,
        requestId: order.request_id, signature: result.signature, stub: result.stub,
      });
      return NextResponse.json({ flow: "jupiter-swap-v2-execute", result, position, persistence: "saved" });
    } catch {
      // The swap already happened. Do not turn a receipt outage into a retryable trade failure.
      return NextResponse.json({ flow: "jupiter-swap-v2-execute", result, position: null, persistence: "failed",
        warning: "Trade executed, but receipt could not be saved. Keep the signature and check your wallet. Do not repeat the trade." });
    }
  } catch (error) {
    const status = error instanceof PositionStoreError ? 503 : error instanceof JupiterError ? error.status : 502;
    return NextResponse.json({ error: error instanceof PositionStoreError || error instanceof JupiterError ? error.message : "Execution status unavailable. Check your wallet before retrying." }, { status });
  }
}
