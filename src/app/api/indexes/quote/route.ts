import { NextResponse } from "next/server";
import { getIndex } from "@/lib/fomo/catalog";
import { allocateIndex, withTokenEstimates } from "@/lib/fomo/indexes";
import { STUB_TOKEN_USD_PRICE } from "@/lib/jupiter";
import { jupiterMode } from "@/lib/runtime";
import { fetchMintPrices } from "@/lib/venues/prices";

export async function POST(request: Request) {
  const body = (await request.json()) as { indexId?: string; usdcAmount?: number };
  const usdcAmount = Number(body.usdcAmount);
  if (!body.indexId || !Number.isFinite(usdcAmount) || usdcAmount <= 0) {
    return NextResponse.json(
      { error: "indexId and a positive usdcAmount are required." },
      { status: 400 },
    );
  }

  const index = await getIndex(body.indexId);
  if (!index || index.constituents.length === 0) {
    return NextResponse.json(
      { error: "Index has no tradable constituents to copy." },
      { status: 404 },
    );
  }

  // Token estimates come from the last on-chain price; a leg Jupiter cannot
  // price (thin Backpack pool) stays null rather than guessed.
  const mints = index.constituents.map((row) => row.mint);
  const prices =
    jupiterMode() === "stub"
      ? Object.fromEntries(mints.map((mint) => [mint, STUB_TOKEN_USD_PRICE]))
      : await fetchMintPrices(mints);
  const allocations = withTokenEstimates(allocateIndex(index, usdcAmount), prices);
  const unpriced = allocations.filter((row) => row.tokens == null);

  return NextResponse.json({
    flow: "person-index-basket",
    mode: jupiterMode(),
    index,
    requestId: `idx-${crypto.randomUUID()}`,
    transaction: Buffer.from(
      JSON.stringify({ kind: "stocklana-index-stub", indexId: index.id, allocations }),
    ).toString("base64"),
    allocations,
    swapLegs: allocations.length,
    unpricedLegs: unpriced.map((row) => row.venueSymbol),
    rebalanceOn: "new-disclosure",
  });
}
