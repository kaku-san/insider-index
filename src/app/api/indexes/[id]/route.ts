import { NextResponse } from "next/server";
import { getIndex, getProfile } from "@/lib/fomo/catalog";
import { VAULT_RELEASE } from "@/lib/index-vaults/release";

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
  return NextResponse.json({ index, profile, holding: null, positionStatus: "unavailable", vaultRelease: VAULT_RELEASE });
}
