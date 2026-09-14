/**
 * Pure parser for Backpack Exchange's public market list.
 * https://api.backpack.exchange/api/v1/markets  (no key)
 *
 * Tokenised US equities and index products carry `rwaMarketType`
 * ("STOCK" | "INDEX") and a `.US` suffixed base symbol (NVDA.US). Both spot
 * and perpetual markets exist; spot is preferred when a ticker has both.
 * No fetch, no env, no path aliases — unit-tested directly with `node --test`.
 */

export type BackpackMarketRow = {
  symbol?: string;
  baseSymbol?: string;
  quoteSymbol?: string;
  marketType?: string;
  rwaMarketType?: string | null;
  orderBookState?: string;
  visible?: boolean;
};

export type BackpackListing = {
  /** Underlying US ticker, e.g. NVDA. */
  ticker: string;
  /** Backpack market symbol, e.g. NVDA.US_USDC_PERP. */
  symbol: string;
  market: "spot" | "perp";
  rwaType: string;
  quote: string;
};

export const BACKPACK_TRADE_BASE = "https://backpack.exchange/trade";

export function backpackTradeUrl(symbol: string): string {
  return `${BACKPACK_TRADE_BASE}/${encodeURIComponent(symbol)}`;
}

export function backpackTickerFromBase(baseSymbol: string): string | null {
  const match = /^([A-Z][A-Z0-9.-]*?)\.US$/i.exec(baseSymbol.trim());
  return match ? match[1].toUpperCase() : null;
}

/** Open, visible, real-world-asset markets only. One row per market. */
export function parseBackpackMarkets(rows: readonly BackpackMarketRow[] | null | undefined): BackpackListing[] {
  if (!Array.isArray(rows)) return [];
  const out: BackpackListing[] = [];
  for (const row of rows) {
    if (!row?.rwaMarketType || !row.symbol || !row.baseSymbol) continue;
    if (row.visible === false) continue;
    if ((row.orderBookState ?? "Open") !== "Open") continue;
    const ticker = backpackTickerFromBase(row.baseSymbol);
    if (!ticker) continue;
    const market = (row.marketType ?? "").toUpperCase() === "PERP" ? "perp" : "spot";
    out.push({ ticker, symbol: row.symbol, market, rwaType: row.rwaMarketType, quote: row.quoteSymbol ?? "USDC" });
  }
  return out;
}

/** Best market per ticker: spot beats perp; otherwise first seen. */
export function indexBackpackListings(listings: readonly BackpackListing[]): Map<string, BackpackListing> {
  const byTicker = new Map<string, BackpackListing>();
  for (const listing of listings) {
    const current = byTicker.get(listing.ticker);
    if (!current || (current.market === "perp" && listing.market === "spot")) {
      byTicker.set(listing.ticker, listing);
    }
  }
  return byTicker;
}
