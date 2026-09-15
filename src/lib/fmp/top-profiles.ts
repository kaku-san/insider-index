import { indexNames } from "./index-name.ts";
import type { SavedSnapshot } from "./holdings-index.ts";
import type { Band, DisclosedItem, ItemKind, Person } from "./types.ts";

export const TOP_PROFILE_COUNT = 20;
export const PINNED_PERSON_ID = "P000197";
export const NO_NET_WORTH_SERIES = "no-verified-net-worth-series";
export const NO_YOY_SERIES = "no-dated-holdings-price-series";
export const NO_SP_OVERLAY_SERIES = "no-benchmark-series";

const ASSET_KINDS = new Set<ItemKind>(["stock", "etf", "option", "other"]);

export type PublishedWeightsInput = {
  hash: string;
  period: string;
  definition?: { methodology?: string | null; snapshotComplete?: boolean };
  constituents: {
    ticker: string;
    mint: string;
    issuer: string;
    weight_bps: number;
    payload?: { holdingIds?: string[] } | null;
  }[];
};

export type RankablePerson = {
  person: Person;
  bookState: string;
  snapshot: SavedSnapshot | null;
  publishedIndex: PublishedWeightsInput | null;
};

export type ProfileHolding = {
  id: string;
  name: string | null;
  ticker: string | null;
  kind: ItemKind;
  owner: string | null;
  valueRange: Band;
  tradable: boolean;
  mint: string | null;
  issuer: string | null;
};

export type ProfilePublishedWeights = {
  hash: string;
  period: string;
  methodology: string | null;
  snapshotComplete: boolean | null;
  constituents: { ticker: string; mint: string; issuer: string; weightBps: number; holdingIds: string[] }[];
};

export type EstimatedValue = {
  low: number | null;
  high: number | null;
  midpoint: number | null;
  valuedHoldings: number;
  totalHoldings: number;
};

export type PoliticianProfile = {
  listOrder: number;
  rank: number;
  pinned: boolean;
  person: Person;
  indexName: string;
  bookState: string;
  snapshotId: string | null;
  snapshotPeriod: string | null;
  dataQuality: {
    complete: boolean;
    partial: boolean;
    snapshotComplete: boolean;
    snapshotIssues: string[];
    estimateComplete: boolean;
  };
  estimatedValue: EstimatedValue;
  holdings: ProfileHolding[];
  publishedWeights: ProfilePublishedWeights | null;
  netWorth: null;
  netWorthReason: typeof NO_NET_WORTH_SERIES;
  yearOverYearReturn: null;
  yearOverYearReturnReason: typeof NO_YOY_SERIES;
  sp500Overlay: null;
  sp500OverlayReason: typeof NO_SP_OVERLAY_SERIES;
};

export type TopProfilesDocument = {
  source: "fmp";
  methodology: "holding-band-midpoints";
  universeSize: number;
  listed: number;
  pelosiPinned: boolean;
  profiles: PoliticianProfile[];
  netWorth: null;
  netWorthReason: typeof NO_NET_WORTH_SERIES;
  yearOverYearReturn: null;
  yearOverYearReturnReason: typeof NO_YOY_SERIES;
  sp500Overlay: null;
  sp500OverlayReason: typeof NO_SP_OVERLAY_SERIES;
};

/** Same closed-band rule as holdings targets: never invent $0 or fill from provider scalars. */
export function closedBandMidpoint(band: Band): number | null {
  const { low, high } = band;
  if (low === null || high === null || !Number.isFinite(low) || !Number.isFinite(high) || low < 0 || high < low || high === 0) return null;
  return low / 2 + high / 2;
}

function omittedSeries() {
  return {
    netWorth: null, netWorthReason: NO_NET_WORTH_SERIES,
    yearOverYearReturn: null, yearOverYearReturnReason: NO_YOY_SERIES,
    sp500Overlay: null, sp500OverlayReason: NO_SP_OVERLAY_SERIES,
  } as const;
}

function estimateAssets(items: readonly DisclosedItem[]): EstimatedValue & { estimateComplete: boolean } {
  const assets = items.filter((item) => ASSET_KINDS.has(item.kind));
  let low = 0, high = 0, midpoint = 0, valued = 0;
  for (const item of assets) {
    const mid = closedBandMidpoint(item.valueRange);
    if (mid === null) continue;
    low += item.valueRange.low!;
    high += item.valueRange.high!;
    midpoint += mid;
    valued++;
  }
  return {
    low: valued ? low : null, high: valued ? high : null, midpoint: valued ? midpoint : null,
    valuedHoldings: valued, totalHoldings: assets.length,
    estimateComplete: assets.length > 0 && valued === assets.length,
  };
}

function overlayHoldings(items: readonly DisclosedItem[], index: PublishedWeightsInput | null): ProfileHolding[] {
  const mapped = new Map<string, { ticker: string; mint: string; issuer: string }>();
  for (const constituent of index?.constituents ?? []) {
    for (const id of constituent.payload?.holdingIds ?? []) {
      mapped.set(id, { ticker: constituent.ticker, mint: constituent.mint, issuer: constituent.issuer });
    }
  }
  return items.map((item) => {
    const token = mapped.get(item.id);
    return {
      id: item.id, name: item.name, ticker: token?.ticker ?? item.ticker, kind: item.kind, owner: item.owner,
      valueRange: item.valueRange, tradable: Boolean(token), mint: token?.mint ?? null, issuer: token?.issuer ?? null,
    };
  });
}

function publishedWeights(index: PublishedWeightsInput | null): ProfilePublishedWeights | null {
  if (!index?.constituents.length) return null;
  return {
    hash: index.hash, period: index.period,
    methodology: index.definition?.methodology ?? null,
    snapshotComplete: index.definition?.snapshotComplete ?? null,
    constituents: index.constituents.map((c) => ({
      ticker: c.ticker, mint: c.mint, issuer: c.issuer, weightBps: c.weight_bps, holdingIds: c.payload?.holdingIds ?? [],
    })),
  };
}

function profileOf(entry: RankablePerson, rank: number, names: Map<string, string>, pinned: boolean, listOrder: number): PoliticianProfile {
  const items = entry.snapshot?.payload.items ?? [];
  const estimated = estimateAssets(items);
  const snapshotComplete = entry.snapshot?.payload.complete === true;
  const snapshotIssues = entry.snapshot?.payload.issues ?? (entry.snapshot ? [] : ["no-annual-book"]);
  const complete = snapshotComplete && estimated.estimateComplete;
  return {
    listOrder, rank, pinned, person: entry.person, indexName: names.get(entry.person.id)!, bookState: entry.bookState,
    snapshotId: entry.snapshot?.id ?? null, snapshotPeriod: entry.snapshot?.payload.referenceDate ?? null,
    dataQuality: {
      complete, partial: !complete, snapshotComplete, snapshotIssues, estimateComplete: estimated.estimateComplete,
    },
    estimatedValue: {
      low: estimated.low, high: estimated.high, midpoint: estimated.midpoint,
      valuedHoldings: estimated.valuedHoldings, totalHoldings: estimated.totalHoldings,
    },
    holdings: overlayHoldings(items, entry.publishedIndex),
    publishedWeights: publishedWeights(entry.publishedIndex),
    ...omittedSeries(),
  };
}

function scoreCmp(a: { midpoint: number | null; id: string }, b: { midpoint: number | null; id: string }) {
  if (a.midpoint !== null && b.midpoint !== null && a.midpoint !== b.midpoint) return b.midpoint - a.midpoint;
  if (a.midpoint !== null && b.midpoint === null) return -1;
  if (a.midpoint === null && b.midpoint !== null) return 1;
  return a.id.localeCompare(b.id);
}

/** Rank saved annual books by closed holding-band midpoints. Pins Pelosi into the top 20. */
export function rankPoliticianProfiles(people: readonly RankablePerson[]): TopProfilesDocument {
  const names = indexNames(people.map((row) => row.person));
  const eligible = people.filter((row) => row.person.id === PINNED_PERSON_ID || (row.snapshot?.payload.items.length ?? 0) > 0);
  const ranked = eligible
    .map((row) => ({ row, id: row.person.id, midpoint: estimateAssets(row.snapshot?.payload.items ?? []).midpoint }))
    .sort(scoreCmp)
    .map((entry, index) => ({ ...entry, rank: index + 1 }));
  const top = ranked.slice(0, TOP_PROFILE_COUNT);
  const pinned = ranked.find((entry) => entry.id === PINNED_PERSON_ID);
  const selected = pinned && !top.some((entry) => entry.id === PINNED_PERSON_ID)
    ? [...top.slice(0, TOP_PROFILE_COUNT - 1), pinned]
    : top;
  const profiles = selected.map((entry, index) => profileOf(entry.row, entry.rank, names, entry.id === PINNED_PERSON_ID, index + 1));
  return {
    source: "fmp", methodology: "holding-band-midpoints", universeSize: people.length, listed: profiles.length,
    pelosiPinned: profiles.some((profile) => profile.person.id === PINNED_PERSON_ID),
    profiles, ...omittedSeries(),
  };
}
