import { NextResponse } from "next/server";
import { listIndexes } from "@/lib/fomo/catalog";
import { VAULT_RELEASE } from "@/lib/index-vaults/release";

export async function GET() {
  const indexes = await listIndexes();
  return NextResponse.json({
    count: indexes.length,
    indexes,
    holdings: [], // No purchase-row ownership ledger; native mint positions not yet connected.
    positionStatus: "unavailable",
    vaultRelease: VAULT_RELEASE,
  });
}
