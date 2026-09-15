import { NextResponse } from "next/server";
import { getAdapterStatus, getRuntimeModes } from "@/lib/health";
import { loadSolanaCatalog } from "@/lib/venues/solana-catalog";
import { assertPositionStoreReady } from "@/lib/positions";

export const dynamic = "force-dynamic";

export async function GET() {
  const catalog = await loadSolanaCatalog();
  const adapters = getAdapterStatus();
  const modes = getRuntimeModes();
  let receipts = false;
  if (adapters.supabase) {
    try { await assertPositionStoreReady(); receipts = true; } catch { /* report unavailable, never secret details */ }
  }
  const copyReady = receipts && adapters.privy && adapters.helius && modes.jupiter !== "stub" && !modes.mocksAllowed && catalog.size > 0;
  return NextResponse.json(
    {
      ok: copyReady,
      adapters,
      modes,
      launch: { track: "A-W0", copyReady, receipts, basketBuy: false, providerCredentialsVerified: false,
        note: "Configuration/storage readiness only. Verify live feeds and a wallet-signed persisted fill before declaring launch." },
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
