import { NextResponse } from "next/server";
import {
  USDC_DECIMALS,
  USDC_MINT,
  canBuyMint,
  toAtomicAmount,
} from "@/lib/allowlist";
import { createHeliusRpc, heliusConfigured } from "@/lib/helius";
import { fetchJupiterOrder } from "@/lib/jupiter";

type QuoteBody = {
  outputMint?: string;
  usdcAmount?: number;
  taker?: string;
};

export async function POST(request: Request) {
  const body = (await request.json()) as QuoteBody;
  const outputMint = body.outputMint?.trim();
  const usdcAmount = Number(body.usdcAmount);

  if (!outputMint || !Number.isFinite(usdcAmount) || usdcAmount <= 0) {
    return NextResponse.json(
      { error: "outputMint and a positive usdcAmount are required." },
      { status: 400 },
    );
  }

  if (!canBuyMint(outputMint)) {
    return NextResponse.json(
      { error: "Buy blocked: output mint is not on the V1 xStock allowlist." },
      { status: 403 },
    );
  }

  createHeliusRpc();

  const order = await fetchJupiterOrder({
    inputMint: USDC_MINT,
    outputMint,
    amount: toAtomicAmount(usdcAmount, USDC_DECIMALS),
    taker: body.taker,
  });

  return NextResponse.json({
    flow: "jupiter-swap-v2-order",
    heliusConfigured: heliusConfigured(),
    order,
  });
}
