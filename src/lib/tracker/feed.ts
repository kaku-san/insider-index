/**
 * Feed rows from the committed PelosiTracker/FMP handoff bundle.
 *
 * The public disclosure tape (`GET /api/disclosures`) is normally fed by the live EDGAR and
 * AInvest ingest lanes. When those lanes are down the tape is empty even though we already hold
 * real, dated disclosures in the committed captain bundle. This module turns that bundle — read
 * through the tracker handoff module, never a second parse layer — into the same `Disclosure`
 * rows the feed already consumes, with honest provenance on every row.
 *
 * These are disclosed filings, not trades we executed, and every dollar is the STOCK Act value
 * band, never a synthesised exact figure. Rows are research-only (`tradeEligible: false`, no
 * Solana venue): the copy path resolves live-lane filings, and a dated third-party scrape must
 * not imply a one-click copy. Sizing / eligibility live behind the live lanes and the buy catalog,
 * which this feed path never touches.
 */
import type { Disclosure, LaneStatus, PoliticalParty } from "@/lib/disclosures/types";
import { normalizeParty } from "@/lib/fomo/party";
import { trackerHandoff } from "./handoff.ts";
import {
  TRACKER_AS_OF,
  TRACKER_SOURCE_LABEL,
  type Band,
  type TrackerHandoff,
  type TrackerLedgerEntry,
  type TrackerProfile,
  type TrackerTrade,
} from "./tracker-parse.ts";

/** Provenance for the served lane. Names the committed source and its scrape date, honestly. */
export const TRACKER_FEED_NOTE =
  `Served from the committed ${TRACKER_SOURCE_LABEL} disclosure bundle (scraped ${TRACKER_AS_OF}). Disclosed filings, not trades we executed; dollar figures are STOCK Act value bands, never exact prices. Research-only: no live venue is implied.` as const;

/** Why the live ingest lanes are off on this response, without probing (and never retrying) them. */
export const LIVE_LANE_OFF_NOTE =
  `Live ingest is not the feed source; served from the committed ${TRACKER_SOURCE_LABEL}/FMP disclosure bundle.` as const;

/** Documented default/max page size so the route can never ship a multi-megabyte payload. */
export const TRACKER_FEED_DEFAULT_LIMIT = 100;
export const TRACKER_FEED_MAX_LIMIT = 500;

function cleanIssuer(asset: string | null, ticker: string): string {
  if (!asset) return ticker;
  const cleaned = asset
    .replace(/\([^)]*\)/g, " ")
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || ticker;
}

function chamberLabel(chamber: TrackerProfile["chamber"]): string | null {
  if (chamber === "house") return "House";
  if (chamber === "senate") return "Senate";
  return null;
}

type BaseRow = {
  ticker: string;
  issuerName: string;
  transactionDate: string;
  filedAt: string;
  side: Disclosure["side"];
  transactionCode: string;
  band: Band | null;
};

function toDisclosure(
  profile: TrackerProfile,
  party: PoliticalParty | null,
  chamber: string | null,
  key: string,
  base: BaseRow,
): Disclosure {
  return {
    id: `pt-${profile.slug}-${key}`,
    accessionNumber: `PELOSITRACKER-${profile.slug}-${key}`.toUpperCase(),
    ticker: base.ticker,
    issuerName: base.issuerName,
    insiderName: profile.name,
    insiderTitle: profile.title,
    insiderCik: profile.id,
    transactionCode: base.transactionCode,
    transactionDate: base.transactionDate,
    filedAt: base.filedAt,
    sharesAmount: null,
    pricePerShare: null,
    transactionValue: null,
    sharesOwnedAfter: null,
    is10b51: false,
    venue: "none",
    venueSymbol: null,
    mint: null,
    mintDecimals: null,
    source: "pelositracker",
    side: base.side,
    tradeEligible: false,
    kind: "politician",
    profileId: profile.id,
    party,
    chamber,
    state: profile.state,
    amountLow: base.band?.low ?? null,
    amountHigh: base.band?.high ?? null,
  };
}

function ledgerRow(profile: TrackerProfile, party: PoliticalParty | null, chamber: string | null, entry: TrackerLedgerEntry): Disclosure | null {
  if (!entry.ticker || !entry.date) return null;
  return toDisclosure(profile, party, chamber, `l${entry.ordinal}`, {
    ticker: entry.ticker,
    issuerName: cleanIssuer(entry.asset, entry.ticker),
    transactionDate: entry.date,
    filedAt: entry.filingDate ?? entry.notificationDate ?? entry.date,
    side: entry.side,
    transactionCode: entry.sourceType ?? "",
    band: entry.amountBand,
  });
}

function tradeRow(profile: TrackerProfile, party: PoliticalParty | null, chamber: string | null, entry: TrackerTrade): Disclosure | null {
  if (!entry.ticker || !entry.date) return null;
  return toDisclosure(profile, party, chamber, `t${entry.ordinal}`, {
    ticker: entry.ticker,
    issuerName: entry.ticker,
    transactionDate: entry.date,
    filedAt: entry.notificationDate ?? entry.date,
    side: entry.side,
    transactionCode: entry.sourceType ?? "",
    band: entry.amountBand,
  });
}

/**
 * Pure: normalized handoff → sorted feed rows. Newest transaction first with a stable tiebreak
 * (filing date, then id) so the same bundle always paginates identically. A profile's full
 * transaction ledger is the body; profiles the tracker has no ledger for fall back to their
 * recent-trades slice so no member is silently empty. Missing / empty bundles yield `[]`.
 */
export function trackerDisclosures(handoff: TrackerHandoff): Disclosure[] {
  const rows: Disclosure[] = [];
  for (const profile of handoff.profiles ?? []) {
    const party = normalizeParty(profile.party);
    const chamber = chamberLabel(profile.chamber);
    const ledger = profile.ledger.length
      ? profile.ledger.flatMap((entry) => { const row = ledgerRow(profile, party, chamber, entry); return row ? [row] : []; })
      : [];
    const source = ledger.length
      ? ledger
      : profile.recentTrades.flatMap((entry) => { const row = tradeRow(profile, party, chamber, entry); return row ? [row] : []; });
    rows.push(...source);
  }
  return rows.sort(
    (a, b) =>
      +new Date(b.transactionDate) - +new Date(a.transactionDate) ||
      b.filedAt.localeCompare(a.filedAt) ||
      a.id.localeCompare(b.id),
  );
}

export type TrackerFeed = { disclosures: Disclosure[]; lane: LaneStatus };

/** Load the feed through the tracker handoff module; degrade to an honest empty state on any fault. */
export function loadTrackerFeed(): TrackerFeed {
  let disclosures: Disclosure[] = [];
  try {
    disclosures = trackerDisclosures(trackerHandoff());
  } catch {
    disclosures = [];
  }
  return {
    disclosures,
    lane: {
      source: "pelositracker",
      live: disclosures.length > 0,
      count: disclosures.length,
      note: disclosures.length ? TRACKER_FEED_NOTE : `No rows in the committed ${TRACKER_SOURCE_LABEL} bundle.`,
    },
  };
}
