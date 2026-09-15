import type { Band, TrackerProfile } from "./tracker-parse.ts";

/**
 * The shown book mixes two dated sources without ever adding them together:
 *
 *  - PelosiTracker positions (current as of the scrape date) are the display source of truth for
 *    a name whenever the tracker lists it; they carry the tracker's percentage and dollar estimate.
 *    When a copy-trade full book exists (Pelosi 15, MTG 76) that book is the shown tracker side;
 *    otherwise the politician-API top-5 slice plus an unitemized OTHER aggregate (no invented tickers).
 *    Copy-trade dollars are a different PelosiTracker product from the disclosure estimate.
 *  - FMP annual disclosure rows (older; usually the 2024-12-31 filing) fill in every other
 *    disclosed name as a dollar band, exactly as filed.
 *
 * A name on both sides is one row with both readings side by side. There is no combined total:
 * the tracker's dollars are a third-party estimate and the annual bands are a filing, so neither is
 * a NAV and the two are never summed.
 */
export type FmpAnnualRowInput = {
  id: string; name: string | null; ticker: string | null; kind: string; owner: string | null;
  valueRange: Band; referenceDate?: string | null; token?: { issuer: string; symbol: string; mint: string } | null;
};
export type FmpResolutionInput = { holding: { id: string }; ticker: string | null; token: { issuer: string; symbol: string; mint: string } | null };
export type FmpConstituentInput = { ticker: string; mint: string; issuer: string; weight_bps: number };

export type ShownBookToken = { issuer: string; symbol: string; mint: string };
export type ShownBookRow = {
  key: string;
  ticker: string | null;
  name: string | null;
  source: "tracker" | "fmp-annual" | "both";
  /** PelosiTracker reading, current as of `asOf`. */
  tracker: { ordinal: number; percentage: number | null; valueUsd: number | null; asOf: string } | null;
  /** FMP annual filing rows for the same ticker (never merged into the tracker figure). */
  fmp: { rows: { id: string; name: string | null; kind: string; owner: string | null; valueRange: Band }[]; referenceDate: string | null } | null;
  token: ShownBookToken | null;
};
export type ShownBook = {
  asOf: string;
  fmpReferenceDate: string | null;
  rows: ShownBookRow[];
  counts: { tracker: number; fmpAnnual: number; both: number };
  note: string;
};

const SYMBOL_HINT = /\(([A-Z][A-Z0-9.-]{0,14})\)/g;
/** Ticker for an annual row: publication evidence first, then the source symbol, then one unambiguous `(SYMB)` in the name. */
export function annualRowTicker(row: FmpAnnualRowInput, resolutions: ReadonlyMap<string, FmpResolutionInput>): string | null {
  const resolved = resolutions.get(row.id)?.ticker ?? row.ticker;
  if (resolved) return resolved.toUpperCase();
  const hints = [...(row.name ?? "").matchAll(SYMBOL_HINT)].map((m) => m[1].toUpperCase());
  return new Set(hints).size === 1 ? hints[0] : null;
}

const bandMid = (band: Band) => (band.low !== null && band.high !== null ? band.low / 2 + band.high / 2 : band.high ?? band.low ?? -1);

export function buildShownBook(
  profile: TrackerProfile,
  annual: { referenceDate: string | null; items: readonly FmpAnnualRowInput[] } | null,
  resolutions: ReadonlyMap<string, FmpResolutionInput> = new Map(),
  tokens: ReadonlyMap<string, ShownBookToken> = new Map(),
): ShownBook {
  const annualByTicker = new Map<string, FmpAnnualRowInput[]>();
  const unresolvedAnnual: FmpAnnualRowInput[] = [];
  for (const item of annual?.items ?? []) {
    const ticker = annualRowTicker(item, resolutions);
    if (!ticker) { unresolvedAnnual.push(item); continue; }
    const rows = annualByTicker.get(ticker) ?? [];
    rows.push(item);
    annualByTicker.set(ticker, rows);
  }
  const tokenFor = (ticker: string | null, rows: readonly FmpAnnualRowInput[]): ShownBookToken | null => {
    if (ticker && tokens.has(ticker)) return tokens.get(ticker)!;
    for (const row of rows) { const token = resolutions.get(row.id)?.token ?? row.token; if (token) return token; }
    return null;
  };
  const rows: ShownBookRow[] = [];
  const claimed = new Set<string>();
  for (const holding of profile.topHoldings) {
    const annualRows = annualByTicker.get(holding.ticker) ?? [];
    if (annualRows.length) claimed.add(holding.ticker);
    rows.push({
      key: `tracker:${holding.ticker}:${holding.ordinal}`, ticker: holding.ticker, name: holding.name,
      source: annualRows.length ? "both" : "tracker",
      tracker: { ordinal: holding.ordinal, percentage: holding.percentage, valueUsd: holding.valueUsd, asOf: profile.asOf },
      fmp: annualRows.length ? { rows: annualRows.map((r) => ({ id: r.id, name: r.name, kind: r.kind, owner: r.owner, valueRange: r.valueRange })), referenceDate: annual?.referenceDate ?? null } : null,
      token: tokenFor(holding.ticker, annualRows),
    });
  }
  if (profile.holdingsBasis !== "copy-trade-full" && profile.unitemizedOther) {
    const other = profile.unitemizedOther;
    rows.push({
      key: "tracker:OTHER", ticker: null, name: other.label,
      source: "tracker",
      tracker: { ordinal: profile.topHoldings.length, percentage: other.percentage, valueUsd: other.valueUsd, asOf: profile.asOf },
      fmp: null, token: null,
    });
  }
  const annualOnly: ShownBookRow[] = [];
  for (const [ticker, items] of annualByTicker) {
    if (claimed.has(ticker)) continue;
    annualOnly.push({
      key: `fmp:${ticker}`, ticker, name: items[0].name, source: "fmp-annual", tracker: null,
      fmp: { rows: items.map((r) => ({ id: r.id, name: r.name, kind: r.kind, owner: r.owner, valueRange: r.valueRange })), referenceDate: annual?.referenceDate ?? null },
      token: tokenFor(ticker, items),
    });
  }
  for (const item of unresolvedAnnual) {
    annualOnly.push({
      key: `fmp:${item.id}`, ticker: null, name: item.name, source: "fmp-annual", tracker: null,
      fmp: { rows: [{ id: item.id, name: item.name, kind: item.kind, owner: item.owner, valueRange: item.valueRange }], referenceDate: annual?.referenceDate ?? null },
      token: tokenFor(null, [item]),
    });
  }
  // Annual-only rows: larger disclosed bands first, then name; band order is presentation, not valuation.
  annualOnly.sort((a, b) => Math.max(...b.fmp!.rows.map((r) => bandMid(r.valueRange))) - Math.max(...a.fmp!.rows.map((r) => bandMid(r.valueRange))) || (a.ticker ?? a.name ?? "").localeCompare(b.ticker ?? b.name ?? ""));
  rows.push(...annualOnly);
  return {
    asOf: profile.asOf, fmpReferenceDate: annual?.referenceDate ?? null, rows,
    counts: { tracker: rows.filter((r) => r.source !== "fmp-annual").length, fmpAnnual: rows.filter((r) => r.source !== "tracker").length, both: rows.filter((r) => r.source === "both").length },
    note: (() => {
      const trackerSide = profile.holdingsBasis === "copy-trade-full"
        ? `PelosiTracker copy-trade positions (${profile.topHoldings.length} names) are current as of ${profile.asOf} and are a different PelosiTracker product from the politician disclosure estimate (top ${profile.disclosureSlice.length} + OTHER)`
        : `PelosiTracker positions are the top ${profile.coverage.holdingsSlice} slice plus an unitemized OTHER aggregate as of ${profile.asOf}; tickers are not invented for OTHER`;
      return annual
        ? `${trackerSide}; the FMP rows are the older annual disclosure (reference ${annual.referenceDate ?? "date unknown"}). The readings sit side by side and are never added together.`
        : `${trackerSide}. No saved FMP annual book exists for this person, so no older disclosure rows are shown.`;
    })(),
  };
}

/** Same-bioguide comparison: tracker top positions vs the published FMP holdings target. Both are kept; neither overwrites the other. */
export type ComparisonRow = {
  ticker: string;
  trackerPercentage: number | null;
  trackerValueUsd: number | null;
  fmpWeightBps: number | null;
  fmpAnnualBand: Band | null;
  presence: "both" | "tracker-only" | "fmp-only";
};
export type Comparison = {
  asOf: string;
  fmpPeriod: string | null;
  fmpPublished: boolean;
  rows: ComparisonRow[];
  overlap: { tickers: string[]; trackerOnly: string[]; fmpOnly: string[] };
  note: string;
};
export function compareWithFmp(
  profile: TrackerProfile,
  published: { period: string; constituents: readonly FmpConstituentInput[] } | null,
  annual: { referenceDate: string | null; items: readonly FmpAnnualRowInput[] } | null,
  resolutions: ReadonlyMap<string, FmpResolutionInput> = new Map(),
): Comparison {
  const weights = new Map<string, number>();
  for (const c of published?.constituents ?? []) weights.set(c.ticker.toUpperCase(), (weights.get(c.ticker.toUpperCase()) ?? 0) + c.weight_bps);
  const bands = new Map<string, Band>();
  for (const item of annual?.items ?? []) {
    const ticker = annualRowTicker(item, resolutions);
    if (!ticker) continue;
    const existing = bands.get(ticker);
    bands.set(ticker, existing ? { low: existing.low !== null && item.valueRange.low !== null ? existing.low + item.valueRange.low : null, high: existing.high !== null && item.valueRange.high !== null ? existing.high + item.valueRange.high : null } : item.valueRange);
  }
  const rows: ComparisonRow[] = profile.topHoldings.map((h) => ({
    ticker: h.ticker, trackerPercentage: h.percentage, trackerValueUsd: h.valueUsd,
    fmpWeightBps: weights.get(h.ticker) ?? null, fmpAnnualBand: bands.get(h.ticker) ?? null,
    presence: weights.has(h.ticker) || bands.has(h.ticker) ? "both" : "tracker-only",
  }));
  const trackerTickers = new Set(profile.topHoldings.map((h) => h.ticker));
  for (const [ticker, bps] of [...weights.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
    if (trackerTickers.has(ticker)) continue;
    rows.push({ ticker, trackerPercentage: null, trackerValueUsd: null, fmpWeightBps: bps, fmpAnnualBand: bands.get(ticker) ?? null, presence: "fmp-only" });
  }
  const both = rows.filter((r) => r.presence === "both").map((r) => r.ticker);
  return {
    asOf: profile.asOf, fmpPeriod: published?.period ?? annual?.referenceDate ?? null, fmpPublished: Boolean(published), rows,
    overlap: { tickers: both, trackerOnly: rows.filter((r) => r.presence === "tracker-only").map((r) => r.ticker), fmpOnly: rows.filter((r) => r.presence === "fmp-only").map((r) => r.ticker) },
    note: published
      ? `Tracker ${profile.holdingsBasis === "copy-trade-full" ? "copy-trade" : "top"} ${profile.topHoldings.length} as of ${profile.asOf} beside the published FMP target (annual reference ${published.period}). Share classes are matched exactly; GOOG and GOOGL are different rows.`
      : annual ? `Tracker ${profile.holdingsBasis === "copy-trade-full" ? "copy-trade" : "top"} ${profile.topHoldings.length} as of ${profile.asOf} beside the saved FMP annual filing (reference ${annual.referenceDate ?? "unknown"}); no FMP index is published for this person.`
        : `Tracker ${profile.holdingsBasis === "copy-trade-full" ? "copy-trade" : "top"} ${profile.topHoldings.length} as of ${profile.asOf}. No saved FMP annual book or published FMP index exists for this person.`,
  };
}
