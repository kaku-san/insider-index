import { NextResponse } from "next/server";
import { canBuyMint, fromAtomicAmount, getXStockByMint } from "@/lib/allowlist";
import { executeJupiterOrder } from "@/lib/jupiter";
import { recordPosition } from "@/lib/positions";

type ExecuteBody = {
  signedTransaction?: string;
  requestId?: string;
  wallet?: string;
  disclosureId?: string;
  ticker?: string;
  outputMint?: string;
  inAmount?: string;
  outAmount?: string;
};

export async function POST(request: Request) {
  const body = (await request.json()) as ExecuteBody;

  if (!body.signedTransaction || !body.requestId) {
    return NextResponse.json(
      { error: "signedTransaction and requestId are required." },
      { status: 400 },
    );
  }

  if (!body.wallet) {
    return NextResponse.json(
      { error: "wallet is required so the user-signed trade can be tracked." },
      { status: 400 },
    );
  }

  if (!body.outputMint || !canBuyMint(body.outputMint)) {
    return NextResponse.json(
      { error: "Copy blocked: mint is not on the V1 xStock allowlist." },
      { status: 403 },
    );
  }

  const xstock = getXStockByMint(body.outputMint);
  if (!xstock) {
    return NextResponse.json({ error: "Unknown allowlisted mint." }, { status: 400 });
  }

  const result = await executeJupiterOrder({
    signedTransaction: body.signedTransaction,
    requestId: body.requestId,
  });

  if (result.status !== "Success") {
    return NextResponse.json({ error: "Jupiter execute failed.", result }, { status: 502 });
  }

  const position = await recordPosition({
    wallet: body.wallet,
    disclosureId: body.disclosureId ?? null,
    ticker: body.ticker ?? xstock.underlyingTickers[0],
    xstockSymbol: xstock.symbol,
    mint: xstock.mint,
    usdcIn: fromAtomicAmount(body.inAmount ?? "0", 6),
    tokensOut: fromAtomicAmount(body.outAmount ?? "0", xstock.decimals),
    requestId: body.requestId,
    signature: result.signature,
    stub: result.stub,
  });

  return NextResponse.json({
    flow: "jupiter-swap-v2-execute",
    result,
    position,
  });
}
