/**
 * PelosiTracker top-20 handoff → typed product profiles. Pure: no env, fetch or `@/` aliases.
 *
 * The handoff is a third-party estimate scraped once (2026-09-15). Its dollar figures are
 * PelosiTracker's model of a member's brokerage book, never net worth and never a vault NAV.
 * Politician-API holdings are a top-5 slice plus an unitemized OTHER aggregate — tickers are never
 * invented for OTHER. Where PelosiTracker also publishes a copy-trade portfolio (Pelosi 15, MTG 76),
 * that full book is the shown current book; it is a different product with a different dollar total
 * and is still not a vault NAV. Trades stay the politician-API recent slice (info only).
 */

export const TRACKER_SOURCE = "pelositracker.app" as const;
export const TRACKER_SOURCE_LABEL = "PelosiTracker" as const;
/** Scrape date of the handoff. Every tracker number on the site is labelled with this date. */
export const TRACKER_AS_OF = "2026-09-15" as const;
export const TRACKER_HOLDINGS_SLICE = 5;
export const TRACKER_TRADES_SLICE = 10;
export const TRACKER_VALUE_LABEL = "PelosiTracker estimated portfolio value · third-party model · not net worth · not vault NAV" as const;
export const COPY_TRADE_VALUE_LABEL = "PelosiTracker copy-trade portfolio · different product from the disclosure estimate · not net worth · not vault NAV" as const;
export type HoldingsBasis = "copy-trade-full" | "disclosure-slice";

export type Band = { low: number | null; high: number | null };

/** STOCK Act dollar bands as PelosiTracker encodes them: the band midpoint carries a `.5`. */
export const TRACKER_AMOUNT_BANDS: readonly { midpoint: number; low: number; high: number }[] = Object.freeze([
  { midpoint: 8_000.5, low: 1_001, high: 15_000 },
  { midpoint: 32_500.5, low: 15_001, high: 50_000 },
  { midpoint: 75_000.5, low: 50_001, high: 100_000 },
  { midpoint: 175_000.5, low: 100_001, high: 250_000 },
  { midpoint: 375_000.5, low: 250_001, high: 500_000 },
  { midpoint: 750_000.5, low: 500_001, high: 1_000_000 },
  { midpoint: 3_000_000.5, low: 1_000_001, high: 5_000_000 },
  { midpoint: 15_000_000.5, low: 5_000_001, high: 25_000_000 },
  { midpoint: 37_500_000.5, low: 25_000_001, high: 50_000_000 },
]);

/** Decode a tracker amount back to its disclosure band; unknown midpoints stay `null`, never `$0`. */
export function trackerAmountBand(amount: unknown): Band | null {
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) return null;
  const band = TRACKER_AMOUNT_BANDS.find((entry) => Math.abs(entry.midpoint - amount) < 0.001);
  return band ? { low: band.low, high: band.high } : null;
}

export type TrackerHolding = { ordinal: number; ticker: string; name: string | null; valueUsd: number | null; percentage: number | null };
export type UnitemizedOther = { label: string; valueUsd: number | null; percentage: number | null; note: string | null };
export type CopyTradeMeta = { totalValueUsd: number | null; holdingsCount: number; warning: string | null; kind: string | null; label: typeof COPY_TRADE_VALUE_LABEL };
export type TrackerTradeFlag = "non-date-label" | "after-scrape-date" | "unknown-band" | "filing-status-missing";
export type TrackerTrade = {
  ordinal: number;
  /** ISO date when the source gave one; otherwise null and `dateLabel` keeps the source text. */
  date: string | null;
  dateLabel: string;
  ticker: string;
  side: "buy" | "sell" | "other";
  sourceType: string | null;
  /** PelosiTracker's scalar; the band below is the honest display. */
  amountEstimateUsd: number | null;
  amountBand: Band | null;
  filingStatus: string | null;
  notificationDate: string | null;
  flags: TrackerTradeFlag[];
};
export type TrackerSector = { sector: string; percentage: number };
export type TrackerPerformancePoint = { date: string; valueUsd: number };
export type TrackerFilingStats = {
  /** False when PelosiTracker publishes no filing statistics for this member (its Senate rows). */
  tracked: boolean;
  averageReportingTimeDays: number | null;
  averageTimeBetweenFilingsDays: number | null;
  daysSinceLastFiling: number | null;
  totalFilings: number | null;
  totalTransactions: number | null;
};
export type TrackerNewsItem = { title: string; date: string | null; source: string | null; url: string | null; description: string | null };
export type TrackerLedgerEntry = {
  ordinal: number;
  date: string | null;
  dateLabel: string;
  ticker: string | null;
  asset: string | null;
  side: "buy" | "sell" | "other";
  sourceType: string | null;
  amountBand: Band | null;
  amountLabel: string | null;
  filingStatus: string | null;
  notificationDate: string | null;
  filingDate: string | null;
  details: string | null;
  flags: TrackerTradeFlag[];
};
export type TrackerFiling = { id: string; filingDate: string | null; filingType: string | null; pdfUrl: string | null; transactionCount: number | null };

/** Parse a PTR-style "$100,001 - $250,000" label into a band. Unknown text stays null, never `$0`. */
export function ptrAmountBand(label: unknown): Band | null {
  const text = typeof label === "string" && label.trim() ? label.trim() : null;
  if (!text) return null;
  const match = /\$?([0-9][0-9,]*)\s*[-–]\s*\$?([0-9][0-9,]*)/.exec(text);
  if (!match) return null;
  const low = Number(match[1].replaceAll(",", ""));
  const high = Number(match[2].replaceAll(",", ""));
  if (!Number.isFinite(low) || !Number.isFinite(high) || low <= 0 || high <= 0) return null;
  return { low, high };
}

export type TrackerProfile = {
  source: typeof TRACKER_SOURCE;
  sourceLabel: typeof TRACKER_SOURCE_LABEL;
  asOf: typeof TRACKER_AS_OF;
  scrapedAt: string;
  sourceUrl: string | null;
  rank: number;
  slug: string;
  /** Congress bioguide ID; the same stable ID the FMP store uses for the House and Senate. */
  id: string;
  name: string;
  title: string | null;
  party: string | null;
  state: string | null;
  district: string | null;
  chamber: "house" | "senate" | "unknown";
  currentMember: boolean | null;
  age: number | null;
  yearsInCongress: string | null;
  bio: string | null;
  committees: string[];
  photo: { local: string; remote: string | null };
  portfolio: { valueUsd: number | null; cashUsd: number | null; monthlyChangePercent: number | null; label: typeof TRACKER_VALUE_LABEL };
  filingStats: TrackerFilingStats;
  sectors: TrackerSector[];
  /** Shown current book: copy-trade full holdings when present, otherwise the politician-API top-5 slice. */
  topHoldings: TrackerHolding[];
  /** Politician-API itemized slice (always ≤5); kept even when the shown book is the copy-trade portfolio. */
  disclosureSlice: TrackerHolding[];
  unitemizedOther: UnitemizedOther | null;
  holdingsBasis: HoldingsBasis;
  copyTrade: CopyTradeMeta | null;
  recentTrades: TrackerTrade[];
  /** Full PelosiTracker transaction ledger when present. Information only — never an index input. */
  ledger: TrackerLedgerEntry[];
  filings: TrackerFiling[];
  tickersTraded: string[];
  performance: { points: TrackerPerformancePoint[]; leadingZeroPoints: number; firstDate: string | null; lastDate: string | null };
  news: TrackerNewsItem[];
  coverage: { holdingsSlice: number; tradesSlice: number; note: string };
};

export type TrackerHandoff = {
  source: typeof TRACKER_SOURCE;
  sourceLabel: typeof TRACKER_SOURCE_LABEL;
  asOf: typeof TRACKER_AS_OF;
  scrapedAt: string;
  selection: string | null;
  count: number;
  partyMix: Record<string, number>;
  profiles: TrackerProfile[];
  issues: string[];
};

type Raw = Record<string, unknown>;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const rec = (value: unknown): Raw => (value && typeof value === "object" && !Array.isArray(value) ? value as Raw : {});
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const str = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const isoDate = (value: unknown): string | null => { const text = str(value); return text && ISO_DATE.test(text) ? text : null; };

export function trackerPhotoPath(slug: string): string { return `/tracker/photos/${slug}.jpg`; }

function chamberOf(title: string | null): TrackerProfile["chamber"] {
  if (!title) return "unknown";
  if (/senator/i.test(title)) return "senate";
  if (/representative|delegate|commissioner/i.test(title)) return "house";
  return "unknown";
}

function holding(raw: unknown, ordinal: number): TrackerHolding | null {
  const row = rec(raw);
  const ticker = str(row.ticker)?.toUpperCase() ?? null;
  if (!ticker) return null;
  return { ordinal, ticker, name: str(row.name), valueUsd: num(row.value), percentage: num(row.percentage) };
}

/** Copy-trade rows use `symbol`/`weight`/`marketValue`. Quantity is ignored: it is never an index weight. */
function copyTradeHolding(raw: unknown, ordinal: number): TrackerHolding | null {
  const row = rec(raw);
  const ticker = str(row.symbol)?.toUpperCase() ?? str(row.ticker)?.toUpperCase() ?? null;
  if (!ticker) return null;
  return { ordinal, ticker, name: str(row.name), valueUsd: num(row.marketValue), percentage: num(row.weight) };
}

function ledgerEntry(raw: unknown, ordinal: number, asOf: string): TrackerLedgerEntry | null {
  const row = rec(raw);
  const ticker = str(row.ticker)?.toUpperCase() ?? null;
  const asset = str(row.asset);
  const amountLabel = str(row.amount);
  const details = str(row.details);
  const filingDate = isoDate(row.filingDate);
  if (!ticker && !asset && !amountLabel && !details && !filingDate) return null;
  const flags: TrackerTradeFlag[] = [];
  const dateText = str(row.transactionDate) ?? str(row.date) ?? "Date not given";
  const date = isoDate(row.transactionDate) ?? isoDate(row.date);
  if (!date) flags.push("non-date-label");
  else if (date > asOf) flags.push("after-scrape-date");
  const amountBand = ptrAmountBand(amountLabel) ?? trackerAmountBand(num(row.amount));
  if (!amountBand) flags.push("unknown-band");
  const filingStatus = str(row.filingStatus);
  if (!filingStatus) flags.push("filing-status-missing");
  const sourceType = str(row.transactionType) ?? str(row.type);
  const side: TrackerLedgerEntry["side"] = /^(P|buy|purchase)/i.test(sourceType ?? "") ? "buy" : /^(S|sell|sale)/i.test(sourceType ?? "") ? "sell" : "other";
  return {
    ordinal, date, dateLabel: dateText, ticker, asset, side, sourceType, amountBand, amountLabel,
    filingStatus, notificationDate: isoDate(row.notificationDate), filingDate: isoDate(row.filingDate),
    details, flags,
  };
}

function filing(raw: unknown): TrackerFiling | null {
  const row = rec(raw);
  const id = str(row.id);
  if (!id) return null;
  const pdf = str(row.pdfUrl);
  return {
    id, filingDate: isoDate(row.filingDate), filingType: str(row.filingType),
    pdfUrl: pdf && /^https:\/\//i.test(pdf) ? pdf : null, transactionCount: num(row.transactionCount),
  };
}

function unitemizedOther(raw: unknown): UnitemizedOther | null {
  const row = rec(raw);
  const label = str(row.label);
  const valueUsd = num(row.value);
  const percentage = num(row.percentage);
  if (!label && valueUsd === null && percentage === null) return null;
  return { label: label ?? "OTHER", valueUsd, percentage, note: str(row.note) };
}

function trade(raw: unknown, ordinal: number, asOf: string): TrackerTrade | null {
  const row = rec(raw);
  const ticker = str(row.ticker)?.toUpperCase() ?? null;
  if (!ticker) return null;
  const flags: TrackerTradeFlag[] = [];
  const dateText = str(row.date) ?? "Date not given";
  const date = isoDate(row.date);
  if (!date) flags.push("non-date-label");
  else if (date > asOf) flags.push("after-scrape-date");
  const amountEstimateUsd = num(row.amount);
  const amountBand = trackerAmountBand(amountEstimateUsd);
  if (!amountBand) flags.push("unknown-band");
  const filingStatus = str(row.filingStatus);
  if (!filingStatus) flags.push("filing-status-missing");
  const sourceType = str(row.type);
  const side: TrackerTrade["side"] = /^(buy|purchase)/i.test(sourceType ?? "") ? "buy" : /^(sell|sale)/i.test(sourceType ?? "") ? "sell" : "other";
  return { ordinal, date, dateLabel: dateText, ticker, side, sourceType, amountEstimateUsd, amountBand, filingStatus, notificationDate: isoDate(row.notificationDate), flags };
}

function filingStats(raw: unknown): TrackerFilingStats {
  const row = rec(raw);
  const stats = {
    averageReportingTimeDays: num(row.averageReportingTimeDays),
    averageTimeBetweenFilingsDays: num(row.averageTimeBetweenFilingsDays),
    daysSinceLastFiling: num(row.daysSinceLastFiling),
    totalFilings: num(row.totalFilings),
    totalTransactions: num(row.totalTransactions),
  };
  // PelosiTracker publishes zero/null stats for members it does not track (its Senate rows); that is
  // absence of tracker coverage, not evidence of zero filings.
  const tracked = Object.values(stats).some((value) => value !== null && value !== 0);
  return { tracked, ...stats };
}

function performance(raw: unknown): TrackerProfile["performance"] {
  const points: TrackerPerformancePoint[] = [];
  for (const entry of list(raw)) {
    const row = rec(entry);
    const date = isoDate(row.date), valueUsd = num(row.value);
    if (date && valueUsd !== null) points.push({ date, valueUsd });
  }
  points.sort((a, b) => a.date.localeCompare(b.date));
  let leadingZeroPoints = 0;
  while (leadingZeroPoints < points.length && points[leadingZeroPoints].valueUsd === 0) leadingZeroPoints++;
  return { points, leadingZeroPoints, firstDate: points[0]?.date ?? null, lastDate: points.at(-1)?.date ?? null };
}

function news(raw: unknown): TrackerNewsItem[] {
  return list(raw).flatMap((entry) => {
    const row = rec(entry);
    const title = str(row.title);
    const url = str(row.url);
    if (!title) return [];
    return [{ title, date: isoDate(row.date), source: str(row.source), url: url && /^https:\/\//i.test(url) ? url : null, description: str(row.description) }];
  });
}

export function normalizeTrackerProfile(raw: unknown, rank: number, scrapedAt: string): TrackerProfile | null {
  const row = rec(raw);
  const id = str(row.bioguideId), slug = str(row.slug), name = str(row.name);
  if (!id || !slug || !name || !/^[A-Z][0-9]{6}$/.test(id) || !/^[a-z0-9-]+$/.test(slug)) return null;
  const title = str(row.title) ?? str(row.role);
  const remotePhoto = str(row.photoUrl);
  const disclosureSlice = list(row.topHoldings).flatMap((entry, i) => { const h = holding(entry, i); return h ? [h] : []; });
  const disclosure = rec(row.disclosureHoldings);
  const other = unitemizedOther(disclosure.unitemizedOther);
  const copyRaw = Object.keys(rec(row.copyTradePortfolioHoldings)).length ? rec(row.copyTradePortfolioHoldings) : rec(row.copyTradePortfolio);
  const copyHoldings = list(copyRaw.holdings).flatMap((entry, i) => { const h = copyTradeHolding(entry, i); return h ? [h] : []; })
    .sort((a, b) => (b.percentage ?? -1) - (a.percentage ?? -1) || a.ticker.localeCompare(b.ticker))
    .map((h, i) => ({ ...h, ordinal: i }));
  const holdingsBasis: HoldingsBasis = copyHoldings.length ? "copy-trade-full" : "disclosure-slice";
  const topHoldings = holdingsBasis === "copy-trade-full" ? copyHoldings : disclosureSlice;
  const copyTrade: CopyTradeMeta | null = copyHoldings.length ? {
    totalValueUsd: num(copyRaw.totalValue), holdingsCount: copyHoldings.length,
    warning: str(copyRaw.warning), kind: str(copyRaw.kind), label: COPY_TRADE_VALUE_LABEL,
  } : null;
  return {
    source: TRACKER_SOURCE, sourceLabel: TRACKER_SOURCE_LABEL, asOf: TRACKER_AS_OF, scrapedAt,
    sourceUrl: (() => {
      const urls = rec(row.sourceUrls);
      const url = str(row.sourceUrl) ?? str(urls.politician);
      return url && /^https:\/\/pelositracker\.app\//.test(url) ? url : null;
    })(),
    rank, slug, id, name, title, party: str(row.party), state: str(row.state),
    district: row.district === null || row.district === undefined ? null : String(row.district),
    chamber: chamberOf(title),
    currentMember: typeof row.currentMember === "boolean" ? row.currentMember : null,
    age: num(row.age), yearsInCongress: str(row.yearsInCongress), bio: str(row.bio),
    committees: list(row.committees).flatMap((value) => { const text = str(value); return text ? [text] : []; }),
    photo: { local: trackerPhotoPath(slug), remote: remotePhoto && /^https:\/\//i.test(remotePhoto) ? remotePhoto : null },
    portfolio: { valueUsd: num(row.portfolioValue), cashUsd: num(row.cashValue), monthlyChangePercent: num(row.monthlyChangePercent), label: TRACKER_VALUE_LABEL },
    filingStats: filingStats(row.filingStats),
    sectors: list(row.sectorDistribution).flatMap((entry) => { const s = rec(entry); const sector = str(s.sector), percentage = num(s.percentage); return sector && percentage !== null ? [{ sector, percentage }] : []; }),
    topHoldings, disclosureSlice, unitemizedOther: other, holdingsBasis, copyTrade,
    recentTrades: list(row.recentTrades).flatMap((entry, i) => { const t = trade(entry, i, TRACKER_AS_OF); return t ? [t] : []; }),
    ledger: list(row.allTransactions).flatMap((entry, i) => { const t = ledgerEntry(entry, i, TRACKER_AS_OF); return t ? [t] : []; }),
    filings: list(row.allFilings).flatMap((entry) => { const f = filing(entry); return f ? [f] : []; }),
    tickersTraded: [...new Set(list(row.allTickersTraded).flatMap((value) => { const ticker = str(value)?.toUpperCase(); return ticker ? [ticker] : []; }))],
    performance: performance(row.performanceHistory),
    news: news(row.news),
    coverage: {
      holdingsSlice: holdingsBasis === "copy-trade-full" ? topHoldings.length : TRACKER_HOLDINGS_SLICE,
      tradesSlice: TRACKER_TRADES_SLICE,
      note: holdingsBasis === "copy-trade-full"
        ? `PelosiTracker copy-trade portfolio: ${topHoldings.length} itemized holdings as scraped ${TRACKER_AS_OF}. Different dollar total from the politician disclosure estimate (top ${TRACKER_HOLDINGS_SLICE} + OTHER). Neither is a vault NAV. The transaction ledger and allTickersTraded are information only and never index weights.`
        : `PelosiTracker top ${TRACKER_HOLDINGS_SLICE} positions plus an unitemized OTHER aggregate as scraped ${TRACKER_AS_OF}; not every lot ever filed. Tickers are not invented for OTHER. The transaction ledger (when PelosiTracker has filings) is information only.`,
    },
  };
}

/** Normalize the whole `top20-agent-brief.json`. Order follows the handoff's rank; issues are reported, never repaired. */
export function normalizeTrackerHandoff(raw: unknown): TrackerHandoff {
  const brief = rec(raw);
  const issues: string[] = [];
  const scrapedAt = str(brief.scrapedAt) ?? `${TRACKER_AS_OF}T00:00:00Z`;
  if (!scrapedAt.startsWith(TRACKER_AS_OF)) issues.push(`scrapedAt ${scrapedAt} is not ${TRACKER_AS_OF}`);
  if (str(brief.source) !== TRACKER_SOURCE) issues.push(`source is ${String(brief.source)}`);
  const directory = list(brief.top20).map(rec);
  const profilesBySlug = rec(brief.profiles);
  const profiles: TrackerProfile[] = [];
  const seen = new Set<string>();
  for (const entry of directory) {
    const slug = str(entry.slug), rank = num(entry.rank);
    if (!slug || rank === null) { issues.push("directory row without slug/rank"); continue; }
    const profile = normalizeTrackerProfile(profilesBySlug[slug], rank, scrapedAt);
    if (!profile) { issues.push(`profile missing or invalid for ${slug}`); continue; }
    if (seen.has(profile.id)) { issues.push(`duplicate bioguide ${profile.id}`); continue; }
    seen.add(profile.id);
    if (str(entry.bioguideId) !== profile.id) issues.push(`directory bioguide mismatch for ${slug}`);
    if (str(entry.localPhoto) !== `photos/${slug}.jpg`) issues.push(`unexpected localPhoto for ${slug}`);
    profiles.push(profile);
  }
  profiles.sort((a, b) => a.rank - b.rank || a.id.localeCompare(b.id));
  const count = num(brief.count) ?? profiles.length;
  if (count !== profiles.length) issues.push(`handoff count ${count} but ${profiles.length} profiles parsed`);
  const partyMix: Record<string, number> = {};
  for (const [party, value] of Object.entries(rec(brief.partyMix))) { const n = num(value); if (n !== null) partyMix[party] = n; }
  if (!Object.keys(partyMix).length) for (const profile of profiles) { const party = profile.party ?? "Unknown"; partyMix[party] = (partyMix[party] ?? 0) + 1; }
  return { source: TRACKER_SOURCE, sourceLabel: TRACKER_SOURCE_LABEL, asOf: TRACKER_AS_OF, scrapedAt, selection: str(brief.selection), count: profiles.length, partyMix, profiles, issues };
}

/** Directory-sized summary for shelves and lists; no series, no trades. */
export type TrackerSummary = Pick<TrackerProfile, "rank" | "slug" | "id" | "name" | "title" | "party" | "state" | "chamber" | "currentMember" | "photo" | "asOf" | "sourceLabel" | "sourceUrl"> & {
  portfolioValueUsd: number | null;
  portfolioValueLabel: typeof TRACKER_VALUE_LABEL;
  monthlyChangePercent: number | null;
  topTickers: string[];
  tradesListed: number;
  holdingsListed: number;
};
export function trackerSummary(profile: TrackerProfile): TrackerSummary {
  return {
    rank: profile.rank, slug: profile.slug, id: profile.id, name: profile.name, title: profile.title, party: profile.party, state: profile.state,
    chamber: profile.chamber, currentMember: profile.currentMember, photo: profile.photo, asOf: profile.asOf, sourceLabel: profile.sourceLabel, sourceUrl: profile.sourceUrl,
    portfolioValueUsd: profile.portfolio.valueUsd, portfolioValueLabel: TRACKER_VALUE_LABEL, monthlyChangePercent: profile.portfolio.monthlyChangePercent,
    topTickers: profile.topHoldings.map((h) => h.ticker), tradesListed: profile.recentTrades.length, holdingsListed: profile.topHoldings.length,
  };
}
