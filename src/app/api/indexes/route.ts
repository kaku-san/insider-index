import { NextResponse } from "next/server";
import { listIndexes } from "@/lib/fomo/catalog";
import { listIndexPositions, markRebalanceFlags } from "@/lib/fomo/indexes";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const wallet = searchParams.get("wallet") ?? undefined;
  const indexes = await listIndexes();
  const holdings = markRebalanceFlags(indexes);
  return NextResponse.json({
    count: indexes.length,
    indexes,
    holdings: wallet ? holdings.filter((row) => row.wallet === wallet) : listIndexPositions(wallet),
  });
}
