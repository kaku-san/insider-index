import { NextResponse } from "next/server";
import { getXStockByMint } from "@/lib/allowlist";
import { getIndex } from "@/lib/fomo/catalog";
import { allocateIndex, withTokenEstimates } from "@/lib/fomo/indexes";

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

  // Only xStock legs get a token estimate; external legs are links, not swaps.
  const prices = Object.fromEntries(
    index.constituents
      .filter((row): row is typeof row & { mint: string } => Boolean(row.mint))
      .map((row) => [row.mint, getXStockByMint(row.mint)?.stubUsdPrice ?? 0]),
  );
  const allocations = withTokenEstimates(allocateIndex(index, usdcAmount), prices);
  const swapLegs = allocations.filter((row) => row.execution === "swap");
  const externalLegs = allocations.filter((row) => row.execution === "external");

  return NextResponse.json({
    flow: "person-index-basket",
    index,
    requestId: `idx-${crypto.randomUUID()}`,
    transaction: Buffer.from(
      JSON.stringify({ kind: "stocklana-index-stub", indexId: index.id, allocations: swapLegs }),
    ).toString("base64"),
    allocations,
    swapLegs: swapLegs.length,
    externalLegs: externalLegs.length,
    rebalanceOn: "new-disclosure",
  });
}
