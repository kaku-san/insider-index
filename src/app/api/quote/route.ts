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
  side?: "buy" | "sell";
};

export async function POST(request: Request) {
  const body = (await request.json()) as QuoteBody;
  const outputMint = body.outputMint?.trim();
  const usdcAmount = Number(body.usdcAmount);
  const side = body.side === "sell" ? "sell" : "buy";

  if (!outputMint || !Number.isFinite(usdcAmount) || usdcAmount <= 0) {
    return NextResponse.json(
      { error: "outputMint and a positive usdcAmount are required." },
      { status: 400 },
    );
  }

  if (!canBuyMint(outputMint)) {
    return NextResponse.json(
      { error: "Copy blocked: mint is not on the V1 xStock allowlist." },
      { status: 403 },
    );
  }

  createHeliusRpc();

  const { getXStockByMint } = await import("@/lib/allowlist");
  const xstock = getXStockByMint(outputMint);
  if (!xstock) {
    return NextResponse.json({ error: "Unknown allowlisted mint." }, { status: 400 });
  }

  const order = await fetchJupiterOrder(
    side === "sell"
      ? {
          inputMint: outputMint,
          outputMint: USDC_MINT,
          amount: toAtomicAmount(usdcAmount / xstock.stubUsdPrice, xstock.decimals),
          taker: body.taker,
        }
      : {
          inputMint: USDC_MINT,
          outputMint,
          amount: toAtomicAmount(usdcAmount, USDC_DECIMALS),
          taker: body.taker,
        },
  );

  return NextResponse.json({
    flow: "jupiter-swap-v2-order",
    heliusConfigured: heliusConfigured(),
    order,
  });
}
