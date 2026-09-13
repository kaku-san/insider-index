import { getXStockByTicker } from "@/lib/allowlist";
import type {
  BacktestPoint,
  Disclosure,
  FomoProfile,
  HorizonInsight,
  IndexConstituent,
  PersonIndex,
  PortfolioHolding,
} from "@/lib/disclosures/types";
import { portraitFor } from "@/lib/fomo/portraits";

const MS_DAY = 86_400_000;

function daysAgo(iso: string): number {
  return (Date.now() - new Date(iso).getTime()) / MS_DAY;
}

function hashUnit(seed: string): number {
  let hash = 0;
  for (const char of seed) {
    hash = (hash * 31 + char.charCodeAt(0)) % 1000;
  }
  return hash / 1000;
}

function tradeReturn(trade: Disclosure, horizonDays: number): number {
  const age = daysAgo(trade.filedAt || trade.transactionDate);
  if (age < horizonDays * 0.15) {
    return hashUnit(`${trade.id}-${horizonDays}`) * 0.04 - 0.01;
  }
  const base = hashUnit(`${trade.profileId}-${trade.ticker}-${horizonDays}`);
  const direction = trade.side === "sell" ? -1 : 1;
  return (0.02 + base * 0.16) * direction;
}

function horizonInsight(trades: Disclosure[], horizon: HorizonInsight["horizon"], days: number): HorizonInsight {
  const windowed = trades.filter((trade) => daysAgo(trade.filedAt || trade.transactionDate) <= days);
  const volumeUsd = windowed.reduce((sum, trade) => sum + (trade.transactionValue ?? 0), 0);
  const weighted = windowed.reduce((sum, trade) => {
    return sum + (trade.transactionValue ?? 0) * tradeReturn(trade, days);
  }, 0);
  const hits = windowed.filter((trade) => tradeReturn(trade, days) > 0).length;
  return {
    horizon,
    returnPct: volumeUsd ? weighted / volumeUsd : 0,
    trades: windowed.length,
    volumeUsd,
    hitRate: windowed.length ? hits / windowed.length : null,
  };
}

export function buildPortfolio(trades: Disclosure[]): PortfolioHolding[] {
  const byTicker = new Map<string, number>();
  for (const trade of trades) {
    const ticker = trade.ticker?.trim().toUpperCase();
    if (!ticker) continue;
    const signed = trade.side === "sell" ? -1 : 1;
    const next = (byTicker.get(ticker) ?? 0) + signed * (trade.transactionValue ?? 0);
    byTicker.set(ticker, next);
  }

  const holdings = [...byTicker.entries()]
    .map(([ticker, valueUsd]) => {
      const xstock = getXStockByTicker(ticker);
      return {
        ticker,
        xstockSymbol: xstock?.symbol ?? null,
        xstockMint: xstock?.mint ?? null,
        valueUsd: Math.max(valueUsd, 0),
        weightPct: 0,
        copyEligible: Boolean(xstock),
      };
    })
    .filter((row) => row.valueUsd > 0)
    .sort((a, b) => b.valueUsd - a.valueUsd);

  const total = holdings.reduce((sum, row) => sum + row.valueUsd, 0) || 1;
  return holdings.map((row) => ({ ...row, weightPct: row.valueUsd / total }));
}

export function buildCurve(profileId: string): BacktestPoint[] {
  const labels = ["12w", "10w", "8w", "6w", "4w", "2w", "Now"];
  let equity = 100;
  return labels.map((label, index) => {
    equity *= 1 + (hashUnit(`${profileId}-curve-${index}`) * 0.08 - 0.015);
    return { label, equity: Number(equity.toFixed(2)) };
  });
}

export function buildPersonIndex(
  profileId: string,
  name: string,
  kind: FomoProfile["kind"],
  party: FomoProfile["party"],
  portfolio: PortfolioHolding[],
  latest: Disclosure | undefined,
): PersonIndex {
  const copyable = portfolio.filter(
    (row): row is PortfolioHolding & { xstockSymbol: string; xstockMint: string } =>
      Boolean(row.copyEligible && row.xstockSymbol && row.xstockMint),
  );
  const total = copyable.reduce((sum, row) => sum + row.valueUsd, 0) || 1;
  const constituents: IndexConstituent[] = copyable.map((row) => ({
    ticker: row.ticker,
    xstockSymbol: row.xstockSymbol,
    mint: row.xstockMint,
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
): FomoProfile {
  const sorted = [...trades].sort((a, b) => +new Date(b.filedAt) - +new Date(a.filedAt));
  const insights = [
    horizonInsight(sorted, "24h", 1),
    horizonInsight(sorted, "30d", 30),
    horizonInsight(sorted, "90d", 90),
  ];
  const eligible = sorted.filter((trade) => trade.tradeEligible);
  const copiedPnl90d = insights[2]?.returnPct ?? 0;
  const portfolio = buildPortfolio(sorted);

  return {
    id,
    ...extras,
    imageUrl: portraitFor(id),
    lastSignalAt: sorted[0]?.filedAt ?? new Date().toISOString(),
    insights,
    hitRate90d: insights[2]?.hitRate ?? 0,
    copiedPnl90d,
    portfolio,
    curve: buildCurve(id),
    latestSignalId: sorted[0]?.id ?? null,
    latestEligibleSignalId: eligible[0]?.id ?? null,
    index: buildPersonIndex(id, extras.name, extras.kind, extras.party, portfolio, sorted[0]),
  };
}

export function signalHeadline(trade: Disclosure): string {
  const verb = trade.side === "sell" ? "dumped" : "just disclosed a buy in";
  const token = trade.xstockSymbol ?? trade.ticker;
  return `${trade.insiderName} ${verb} ${token}`;
}

export function signalFomo(trade: Disclosure): string {
  if (trade.kind === "politician" && trade.party) {
    return `${trade.party.slice(0, 3).toUpperCase()} tape · ${trade.state ?? "US"}`;
  }
  return trade.insiderTitle ?? "Executive tape";
}
