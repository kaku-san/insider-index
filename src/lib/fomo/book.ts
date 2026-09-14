/**
 * Pure reconstruction of a filer's disclosed book from their filing history.
 * No fetch, no env, no path aliases — unit-tested directly with `node --test`.
 *
 * Insiders (Form 4) report "shares owned following the transaction", so the
 * position is the newest post-trade holding × the price on that print. A CEO
 * who only ever sells stays in the book at their remaining stake.
 *
 * Politicians (STOCK Act PTRs) report dollar *bands*, not holdings. We keep a
 * running net range: a buy adds [low, high]; a sell subtracts the band the
 * other way round (low − sellHigh, high − sellLow), floored at zero. Sells with
 * no prior buy on record mean they held it before our history starts: the name
 * stays visible as `sold` with an unknown size instead of being dropped.
 */

import type { DisclosureSide, HoldingStatus } from "../disclosures/types";

export type BookTrade = {
  id: string;
  ticker: string;
  issuerName: string;
  side: DisclosureSide;
  kind: "insider" | "politician";
  transactionDate: string;
  filedAt: string;
  transactionValue: number | null;
  amountLow: number | null;
  amountHigh: number | null;
  sharesOwnedAfter: number | null;
  pricePerShare: number | null;
};

export type BookEntry = {
  ticker: string;
  issuerName: string;
  status: HoldingStatus;
  /** Midpoint estimate; 0 when the size is unknown. */
  valueUsd: number;
  valueLow: number | null;
  valueHigh: number | null;
  buys: number;
  sells: number;
  lastSide: DisclosureSide;
  firstTradeAt: string;
  lastTradeAt: string;
  latestDisclosureId: string;
  latestBuyDisclosureId: string | null;
};

export type BookOptions = {
  /** Fallback price for an insider holding whose print carried no price. */
  priceFor?: (ticker: string) => number | null;
};

function when(trade: Pick<BookTrade, "filedAt" | "transactionDate">): number {
  const at = Date.parse(trade.transactionDate || trade.filedAt);
  return Number.isFinite(at) ? at : Date.parse(trade.filedAt) || 0;
}

/** Reported band for a trade; falls back to a point value when no band exists. */
export function tradeBand(trade: Pick<BookTrade, "amountLow" | "amountHigh" | "transactionValue">): {
  low: number | null;
  high: number | null;
} {
  if (trade.amountLow != null || trade.amountHigh != null) {
    return { low: trade.amountLow ?? trade.amountHigh, high: trade.amountHigh ?? trade.amountLow };
  }
  if (trade.transactionValue != null) return { low: trade.transactionValue, high: trade.transactionValue };
  return { low: null, high: null };
}

export function bandMidpoint(band: { low: number | null; high: number | null }): number | null {
  if (band.low == null && band.high == null) return null;
  return ((band.low ?? band.high ?? 0) + (band.high ?? band.low ?? 0)) / 2;
}

function insiderPosition(trades: BookTrade[], options: BookOptions): { low: number; high: number } | null {
  // Newest print with a post-transaction holding wins, including a reported 0.
  for (const trade of [...trades].sort((a, b) => when(b) - when(a))) {
    if (trade.sharesOwnedAfter == null) continue;
    const price = trade.pricePerShare ?? options.priceFor?.(trade.ticker) ?? null;
    if (price == null || price <= 0) continue;
    const value = Math.max(0, trade.sharesOwnedAfter * price);
    return { low: value, high: value };
  }
  return null;
}

function politicianPosition(trades: BookTrade[]): { low: number; high: number; sized: boolean } {
  let low = 0;
  let high = 0;
  let sized = false;
  for (const trade of trades) {
    const band = tradeBand(trade);
    if (band.low == null && band.high == null) continue;
    sized = true;
    const bandLow = band.low ?? band.high ?? 0;
    const bandHigh = band.high ?? band.low ?? 0;
    if (trade.side === "buy") {
      low += bandLow;
      high += bandHigh;
    } else if (trade.side === "sell") {
      low = Math.max(0, low - bandHigh);
      high = Math.max(0, high - bandLow);
    }
  }
  return { low, high, sized };
}

function statusFor(buys: number, sells: number, high: number | null): HoldingStatus {
  if (buys === 0 && sells > 0) return "sold";
  if (sells > 0 && (high ?? 0) <= 0) return "exited";
  if (sells > 0) return "reduced";
  return "holding";
}

/**
 * Every ticker on the filer's record, newest activity first inside a value sort.
 * Nothing is dropped for being untradable; venue tagging happens downstream.
 */
export function buildBook(trades: readonly BookTrade[], options: BookOptions = {}): BookEntry[] {
  const byTicker = new Map<string, BookTrade[]>();
  for (const trade of trades) {
    const ticker = trade.ticker?.trim().toUpperCase();
    if (!ticker) continue;
    const bucket = byTicker.get(ticker) ?? [];
    bucket.push({ ...trade, ticker });
    byTicker.set(ticker, bucket);
  }

  const entries: BookEntry[] = [];
  for (const [ticker, rows] of byTicker) {
    const oldestFirst = [...rows].sort((a, b) => when(a) - when(b));
    const newest = oldestFirst[oldestFirst.length - 1];
    const buys = oldestFirst.filter((row) => row.side === "buy").length;
    const sells = oldestFirst.filter((row) => row.side === "sell").length;
    const latestBuy = [...oldestFirst].reverse().find((row) => row.side === "buy") ?? null;
    const insider = oldestFirst.some((row) => row.kind === "insider");

    let low: number | null = null;
    let high: number | null = null;
    let reportedPosition = false;
    if (insider) {
      const position = insiderPosition(oldestFirst, options);
      if (position) {
        // A reported post-transaction holding is authoritative, whatever the sides were.
        low = position.low;
        high = position.high;
        reportedPosition = true;
      } else {
        const net = politicianPosition(oldestFirst);
        if (net.sized) {
          low = net.low;
          high = net.high;
        }
      }
    } else {
      const net = politicianPosition(oldestFirst);
      if (net.sized && buys > 0) {
        low = net.low;
        high = net.high;
      }
    }

    const status = reportedPosition
      ? (high ?? 0) > 0 ? (sells > 0 ? "reduced" : "holding") : "exited"
      : statusFor(buys, sells, high);
    const value = status === "sold" ? 0 : (bandMidpoint({ low, high }) ?? 0);
    entries.push({
      ticker,
      issuerName: newest.issuerName || ticker,
      status,
      valueUsd: Math.max(0, value),
      valueLow: status === "sold" ? null : low,
      valueHigh: status === "sold" ? null : high,
      buys,
      sells,
      lastSide: newest.side,
      firstTradeAt: oldestFirst[0].transactionDate || oldestFirst[0].filedAt,
      lastTradeAt: newest.transactionDate || newest.filedAt,
      latestDisclosureId: newest.id,
      latestBuyDisclosureId: latestBuy?.id ?? null,
    });
  }

  return entries.sort(
    (a, b) => b.valueUsd - a.valueUsd || when({ filedAt: b.lastTradeAt, transactionDate: b.lastTradeAt }) - when({ filedAt: a.lastTradeAt, transactionDate: a.lastTradeAt }),
  );
}

/** Horizon roll-up: counts and reported size, never a synthetic return. */
export function summarizeWindow(
  trades: readonly Pick<BookTrade, "filedAt" | "transactionDate" | "amountLow" | "amountHigh" | "transactionValue">[],
  windowDays: number,
  now = Date.now(),
): { trades: number; volumeUsd: number | null; volumeLow: number | null; volumeHigh: number | null } {
  const windowed = trades.filter((trade) => {
    const at = Date.parse(trade.filedAt || trade.transactionDate);
    return Number.isFinite(at) && now - at <= windowDays * 86_400_000;
  });
  let volumeUsd: number | null = null;
  let volumeLow: number | null = null;
  let volumeHigh: number | null = null;
  for (const trade of windowed) {
    const band = tradeBand(trade);
    const mid = bandMidpoint(band);
    if (mid == null) continue;
    volumeUsd = (volumeUsd ?? 0) + mid;
    volumeLow = (volumeLow ?? 0) + (band.low ?? band.high ?? 0);
    volumeHigh = (volumeHigh ?? 0) + (band.high ?? band.low ?? 0);
  }
  return { trades: windowed.length, volumeUsd, volumeLow, volumeHigh };
}
