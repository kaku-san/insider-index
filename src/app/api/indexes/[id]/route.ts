import { NextResponse } from "next/server";
import { getIndex, getProfile } from "@/lib/fomo/catalog";
import { listIndexPositions, markRebalanceFlags } from "@/lib/fomo/indexes";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const index = await getIndex(id);
  if (!index) {
    return NextResponse.json({ error: "Index not found" }, { status: 404 });
  }
  const profile = await getProfile(index.profileId);
  const { searchParams } = new URL(request.url);
  const wallet = searchParams.get("wallet") ?? undefined;
  markRebalanceFlags([index]);
  const holding = listIndexPositions(wallet).find((row) => row.indexId === index.id) ?? null;
  return NextResponse.json({ index, profile, holding });
}
