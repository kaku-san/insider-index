import { getXStockByTicker } from "@/lib/allowlist";
import type {
  Disclosure,
  FomoProfile,
  HorizonInsight,
  IndexConstituent,
  PersonIndex,
  PortfolioHolding,
} from "@/lib/disclosures/types";
import { buildBook, summarizeWindow } from "@/lib/fomo/book";
import { portraitFor } from "@/lib/fomo/portraits";

/**
 * Per-horizon activity roll-up. Counts and reported sizes only: a return or
 * hit rate needs dated trades *and* a price series, and we do not have the
 * latter yet, so both stay null rather than being invented.
 */
function horizonInsight(trades: Disclosure[], horizon: HorizonInsight["horizon"], days: number, now: number): HorizonInsight {
  const summary = summarizeWindow(trades, days, now);
  return {
    horizon,
    returnPct: null,
    trades: summary.trades,
    volumeUsd: summary.volumeUsd,
    volumeLow: summary.volumeLow,
    volumeHigh: summary.volumeHigh,
    hitRate: null,
  };
}

/**
 * Full disclosed book: every ticker on the filer's record, with the venue tag
 * carried over from the newest print for that name. Nothing is dropped for
 * being untradable; `copyEligible` is the only thing the venue changes.
 */
export function buildPortfolio(trades: Disclosure[]): PortfolioHolding[] {
  const entries = buildBook(trades, {
    priceFor: (ticker) => getXStockByTicker(ticker)?.stubUsdPrice ?? null,
  });
  const newestByTicker = new Map<string, Disclosure>();
  for (const trade of trades) {
    const key = trade.ticker.trim().toUpperCase();
    const current = newestByTicker.get(key);
    if (!current || Date.parse(trade.filedAt) > Date.parse(current.filedAt)) newestByTicker.set(key, trade);
  }
  const total = entries.reduce((sum, row) => sum + row.valueUsd, 0) || 1;
  return entries.map((entry) => {
    const tag = newestByTicker.get(entry.ticker);
    const venue = tag?.venue ?? "none";
    return {
      ...entry,
      xstockSymbol: tag?.xstockSymbol ?? null,
      xstockMint: tag?.xstockMint ?? null,
      venue,
      venueSymbol: tag?.venueSymbol ?? null,
      venueMarket: tag?.venueMarket ?? null,
      venueHref: tag?.venueHref ?? null,
      weightPct: entry.valueUsd / total,
      copyEligible: venue !== "none",
    };
  });
}

/**
 * A person's basket: the tradable names in their disclosed book with a
 * positive estimated position, weighted by that estimate. xStock legs execute
 * in-app; other venues are carried as labelled external legs.
 */
export function buildPersonIndex(
  profileId: string,
  name: string,
  kind: FomoProfile["kind"],
  party: FomoProfile["party"],
  portfolio: PortfolioHolding[],
  latest: Disclosure | undefined,
): PersonIndex {
  const tradable = portfolio.filter(
    (row): row is PortfolioHolding & { venue: "xstock" | "backpack"; venueSymbol: string; venueMarket: NonNullable<PortfolioHolding["venueMarket"]> } =>
      row.venue !== "none" && Boolean(row.venueSymbol && row.venueMarket) && row.valueUsd > 0,
  );
  const total = tradable.reduce((sum, row) => sum + row.valueUsd, 0) || 1;
  const constituents: IndexConstituent[] = tradable.map((row) => ({
    ticker: row.ticker,
    xstockSymbol: row.xstockSymbol,
    mint: row.xstockMint,
    venue: row.venue,
    venueSymbol: row.venueSymbol,
    venueMarket: row.venueMarket,
    venueHref: row.venueHref,
    valueUsd: row.valueUsd,
    weightPct: row.valueUsd / total,
  }));

  return {
    id: `idx-${profileId}`,
    profileId,
    name: `${name} Index`,
    imageUrl: portraitFor(profileId),
    kind,
    party,
    constituents,
    lastDisclosureId: latest?.id ?? null,
    lastDisclosureAt: latest?.filedAt ?? null,
  };
}

export function buildProfile(
  id: string,
  trades: Disclosure[],
  extras: Pick<FomoProfile, "kind" | "name" | "handle" | "title" | "party" | "chamber" | "state" | "cikOrBioguide" | "followers">,
  now = Date.now(),
): FomoProfile {
  const sorted = [...trades].sort((a, b) => +new Date(b.filedAt) - +new Date(a.filedAt));
  const insights = [
    horizonInsight(sorted, "24h", 1, now),
    horizonInsight(sorted, "30d", 30, now),
    horizonInsight(sorted, "90d", 90, now),
  ];
  const eligible = sorted.filter((trade) => trade.tradeEligible);
  const portfolio = buildPortfolio(sorted);

  return {
    id,
    ...extras,
    imageUrl: portraitFor(id),
    lastSignalAt: sorted[0]?.filedAt ?? new Date(now).toISOString(),
    insights,
    hitRate90d: insights[2]?.hitRate ?? null,
    copiedPnl90d: insights[2]?.returnPct ?? null,
    portfolio,
    // No price series yet → no curve. The UI says so instead of drawing one.
    curve: [],
    latestSignalId: sorted[0]?.id ?? null,
    latestEligibleSignalId: eligible[0]?.id ?? null,
    index: buildPersonIndex(id, extras.name, extras.kind, extras.party, portfolio, sorted[0]),
  };
}

export function signalHeadline(trade: Disclosure): string {
  const verb = trade.side === "sell" ? "dumped" : "just disclosed a buy in";
  const token = trade.venueSymbol ?? trade.ticker;
  return `${trade.insiderName} ${verb} ${token}`;
}

export function signalFomo(trade: Disclosure): string {
  if (trade.kind === "politician" && trade.party) {
    return `${trade.party.slice(0, 3).toUpperCase()} tape · ${trade.state ?? "US"}`;
  }
  return trade.insiderTitle ?? "Executive tape";
}
