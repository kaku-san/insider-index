import { NextResponse } from "next/server";
import { getProfile, getProfileTrades } from "@/lib/fomo/catalog";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const profile = await getProfile(id);
  if (!profile) {
    return NextResponse.json({ error: "Profile not found" }, { status: 404 });
  }
  const trades = await getProfileTrades(id);
  return NextResponse.json({ profile, trades });
}
