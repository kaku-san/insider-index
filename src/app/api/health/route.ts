import { NextResponse } from "next/server";
import { getAdapterStatus, getRuntimeModes } from "@/lib/health";
import { loadSolanaCatalog } from "@/lib/venues/solana-catalog";

export const dynamic = "force-dynamic";

export async function GET() {
  const catalog = await loadSolanaCatalog();
  return NextResponse.json(
    {
      ok: true,
      adapters: getAdapterStatus(),
      modes: getRuntimeModes(),
      /** Solana buy catalog per issuer: live fetch or committed snapshot, never a hand list. */
      catalog: { mints: catalog.size, tickers: catalog.byTicker.size, feeds: catalog.feeds },
    },
    {
      headers: {
        "Cache-Control": "no-store",
      },
    },
  );
}
