import { NextResponse } from "next/server";
import type { LaneStatus } from "@/lib/disclosures/types";
import { loadSolanaCatalog } from "@/lib/venues/solana-catalog";
import {
  LIVE_LANE_OFF_NOTE,
  TRACKER_FEED_DEFAULT_LIMIT,
  TRACKER_FEED_MAX_LIMIT,
  loadTrackerFeed,
} from "@/lib/tracker/feed";

export const dynamic = "force-dynamic";

/**
 * The disclosure tape is served from the committed PelosiTracker/FMP bundle (through the tracker
 * handoff module), not from the live EDGAR/AInvest ingest lanes. Those lanes are reported off with
 * honest provenance instead of being probed or retried, so the feed stays full even while they are
 * down. Rows are research-only and carry STOCK Act value bands, never exact prices. The payload is
 * bounded by a documented page size; the full ledger stays reachable behind `?page=`.
 */
function offLane(): LaneStatus {
  return { source: "off", live: false, count: 0, note: LIVE_LANE_OFF_NOTE };
}

function clampInt(value: string | null, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const ticker = searchParams.get("ticker")?.toUpperCase();
  const limit = clampInt(searchParams.get("limit"), TRACKER_FEED_DEFAULT_LIMIT, 1, TRACKER_FEED_MAX_LIMIT);
  const page = clampInt(searchParams.get("page"), 1, 1, Number.MAX_SAFE_INTEGER);

  const [feed, catalog] = await Promise.all([
    Promise.resolve(loadTrackerFeed()),
    loadSolanaCatalog(),
  ]);
  const filtered = feed.disclosures.filter((row) => (ticker ? row.ticker === ticker : true));

  const total = filtered.length;
  const pageCount = Math.max(1, Math.ceil(total / limit));
  const start = (page - 1) * limit;
  const disclosures = filtered.slice(start, start + limit);
  const hasMore = start + disclosures.length < total;

  const lanes = { insiders: offLane(), congress: offLane(), tracker: feed.lane };
  return NextResponse.json(
    {
      source: feed.lane.source,
      lanes,
      /** Which Solana mint catalogs are loaded (live vs committed snapshot). */
      catalog: catalog.feeds,
      live: feed.lane.live,
      congress: "off",
      /** Rows on this page; `total` is the full filtered book behind paging. */
      count: disclosures.length,
      total,
      page,
      pageSize: limit,
      pageCount,
      hasMore,
      /** More rows exist behind `?page=` than shipped here. */
      partial: hasMore,
      form4Count: disclosures.filter((row) => row.kind === "insider").length,
      congressCount: disclosures.filter((row) => row.kind === "politician").length,
      tradeEligibleCount: disclosures.filter((row) => row.tradeEligible).length,
      disclosures,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
