import { NextResponse } from "next/server";
import { USDC_DECIMALS, USDC_MINT, resolveBuyableMint, toAtomicAmount } from "@/lib/allowlist";
import { heliusConfigured } from "@/lib/helius";
import { JupiterError, STUB_TOKEN_USD_PRICE, fetchJupiterOrder } from "@/lib/jupiter";
import { jupiterMode } from "@/lib/runtime";
import { fetchMintPrices } from "@/lib/venues/prices";
import { isStubWallet } from "@/lib/wallet";

export const dynamic = "force-dynamic";

type QuoteBody = {
  outputMint?: string;
  usdcAmount?: number;
  taker?: string;
  side?: "buy" | "sell";
  /** Token quantity for sells (UI units). When absent we cannot size a live sell. */
  tokenAmount?: number;
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

  const token = await resolveBuyableMint(outputMint);
  if (!token) {
    return NextResponse.json(
      { error: "Copy blocked: mint is not an xStock or Backpack tokenised stock in the Solana catalog." },
      { status: 403 },
    );
  }

  // The stub wallet cannot sign a real Jupiter transaction. In live mode we
  // quote without a taker so the user still sees live pricing but never gets a
  // signable order they cannot settle.
  const requestedTaker = body.taker?.trim() || undefined;
  const taker =
    jupiterMode() === "stub" || !isStubWallet(requestedTaker) ? requestedTaker : undefined;

  try {
    let order;
    if (side === "sell") {
      // Sells are sized in tokens. Prefer an explicit token quantity; otherwise
      // convert the USDC notional at the last on-chain price (stub price in stub mode).
      let tokens = Number(body.tokenAmount);
      if (!Number.isFinite(tokens) || tokens <= 0) {
        const price = jupiterMode() === "stub" ? STUB_TOKEN_USD_PRICE : (await fetchMintPrices([token.mint]))[token.mint];
        if (!price) {
          return NextResponse.json(
            { error: `No live price for ${token.symbol}; pass tokenAmount to size this sell.` },
            { status: 409 },
          );
        }
        tokens = usdcAmount / price;
      }
      order = await fetchJupiterOrder({
        inputMint: outputMint,
        outputMint: USDC_MINT,
        amount: toAtomicAmount(tokens, token.decimals),
        taker,
      });
    } else {
      order = await fetchJupiterOrder({
        inputMint: USDC_MINT,
        outputMint,
        amount: toAtomicAmount(usdcAmount, USDC_DECIMALS),
        taker,
      });
    }

    return NextResponse.json(
      {
        flow: "jupiter-swap-v2-order",
        mode: order.mode,
        token: { symbol: token.symbol, issuer: token.issuer, mint: token.mint, decimals: token.decimals },
        heliusConfigured: heliusConfigured(),
        signable: Boolean(order.transaction),
        order,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const status = error instanceof JupiterError ? error.status : 502;
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Jupiter quote failed." },
      { status },
    );
  }
}
