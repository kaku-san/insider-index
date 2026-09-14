import { NextResponse } from "next/server";
import { fromAtomicAmount, resolveBuyableMint } from "@/lib/allowlist";
import { JupiterError, executeJupiterOrder } from "@/lib/jupiter";
import { recordPosition } from "@/lib/positions";

export const dynamic = "force-dynamic";

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

  const token = body.outputMint ? await resolveBuyableMint(body.outputMint) : null;
  if (!token) {
    return NextResponse.json(
      { error: "Copy blocked: mint is not an xStock or Backpack tokenised stock in the Solana catalog." },
      { status: 403 },
    );
  }

  let result;
  try {
    result = await executeJupiterOrder({
      signedTransaction: body.signedTransaction,
      requestId: body.requestId,
    });
  } catch (error) {
    const status = error instanceof JupiterError ? error.status : 502;
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Jupiter execute failed." },
      { status },
    );
  }

  if (result.status !== "Success") {
    return NextResponse.json(
      { error: result.error ? `Jupiter execute failed: ${result.error}` : "Jupiter execute failed.", result },
      { status: 502 },
    );
  }

  const position = await recordPosition({
    wallet: body.wallet,
    disclosureId: body.disclosureId ?? null,
    ticker: body.ticker ?? token.ticker,
    tokenSymbol: token.symbol,
    venue: token.issuer,
    mint: token.mint,
    usdcIn: fromAtomicAmount(result.inputAmountResult ?? body.inAmount ?? "0", 6),
    tokensOut: fromAtomicAmount(result.outputAmountResult ?? body.outAmount ?? "0", token.decimals),
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
