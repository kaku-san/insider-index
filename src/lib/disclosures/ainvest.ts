/**
 * AInvest Congressional Trades adapter — primary House/Senate source.
 * Free tier, Bearer key from https://www.ainvest.com/business/developer-manage/
 *
 * Requires AINVEST_API_KEY. Without it this adapter is "unconfigured" and the
 * caller decides whether to fall back (Form4API) or leave the lane empty.
 *
 * The endpoint is ticker-scoped and there is no per-member or unfiltered pull
 * (docs: `ticker` is required), so a filer's book is assembled by crawling a
 * wide ticker universe and grouping rows by name. Each ticker is memoised on
 * its own so a partial crawl still serves and a refresh only re-pulls what
 * expired. Nothing is filtered by tradability here.
 */

import { mapLimit, memo } from "@/lib/cache";
import {
  buildCongressUniverse,
  parseTickerList,
  parseUniverseMode,
} from "@/lib/disclosures/universe";
import {
  AInvestError,
  normalizeAInvestCongressRow,
  unwrapAInvestEnvelope,
  type AInvestCongressRow,
  type AInvestEnvelope,
  type NormalizedCongressTrade,
} from "@/lib/disclosures/ainvest-parse";
import { catalogTickers } from "@/lib/venues/catalog-parse";
import { loadSolanaCatalog } from "@/lib/venues/solana-catalog";

export const AINVEST_BASE = "https://openapi.ainvest.com/open";

function envInt(name: string, fallback: number, min = 1): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= min ? Math.floor(value) : fallback;
}

/** Rows per page. AInvest defaults to 10; we ask for more to save calls. */
const PAGE_SIZE = envInt("AINVEST_PAGE_SIZE", 100);
/** Pages pulled per ticker; deeper = longer per-person history, more requests. */
const PAGES_PER_TICKER = envInt("AINVEST_PAGES_PER_TICKER", 2);
const TICKER_CONCURRENCY = envInt("AINVEST_CONCURRENCY", 3);
/** Per-ticker memo. Long, with stale-while-revalidate, so the crawl is incremental. */
const TICKER_TTL_MS = envInt("AINVEST_TICKER_TTL_MINUTES", 6 * 60) * 60_000;
const TAPE_TTL_MS = 30 * 60_000;
/** Stop the crawl after this many consecutive rate-limit hits; serve what we have. */
const RATE_LIMIT_PATIENCE = 3;

/**
 * Which tickers to ask AInvest about — see `buildCongressUniverse`.
 *  - AINVEST_TICKERS="NVDA,AAPL,…"   explicit list, nothing else
 *  - AINVEST_UNIVERSE=wide|catalog|full
 */
export async function ainvestUniverse(): Promise<string[]> {
  const explicit = parseTickerList(process.env.AINVEST_TICKERS);
  if (explicit.length) return buildCongressUniverse("catalog", { xstocks: [], backpack: [] }, explicit);
  const catalog = await loadSolanaCatalog();
  return buildCongressUniverse(parseUniverseMode(process.env.AINVEST_UNIVERSE), {
    xstocks: catalogTickers(catalog.tokens, "xstock"),
    backpack: catalogTickers(catalog.tokens, "backpack"),
  });
}

export function ainvestApiKey(): string | null {
  return process.env.AINVEST_API_KEY?.trim() || null;
}

export function ainvestConfigured(): boolean {
  return Boolean(ainvestApiKey());
}

export function isAuthFailure(error: unknown): boolean {
  // 4010 no auth / 5112 invalid key: every ticker will fail the same way.
  return error instanceof AInvestError && (error.statusCode === 4010 || error.statusCode === 5112);
}

export function isRateLimit(error: unknown): boolean {
  if (!(error instanceof AInvestError)) return false;
  return error.statusCode === 429 || /rate|limit|quota|exceed|too many/i.test(error.message);
}

async function ainvestGet<T>(path: string, query: Record<string, string>, apiKey: string): Promise<T[]> {
  const search = new URLSearchParams(query);
  const response = await fetch(`${AINVEST_BASE}${path}?${search.toString()}`, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
    },
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 429) throw new AInvestError(429, "rate limited");
  if (!response.ok) {
    throw new AInvestError(response.status, `HTTP ${response.status}`);
  }
  return unwrapAInvestEnvelope((await response.json()) as AInvestEnvelope<T>);
}

export async function fetchAInvestCongressTicker(
  ticker: string,
  apiKey: string,
  size = PAGE_SIZE,
  pages = PAGES_PER_TICKER,
): Promise<NormalizedCongressTrade[]> {
  const symbol = ticker.trim().toUpperCase();
  const out: NormalizedCongressTrade[] = [];
  for (let page = 1; page <= pages; page += 1) {
    const rows = await ainvestGet<AInvestCongressRow>(
      "/ownership/congress",
      { ticker: symbol, page: String(page), size: String(size) },
      apiKey,
    );
    out.push(
      ...rows
        .map((row) => normalizeAInvestCongressRow(row, symbol))
        .filter((row): row is NormalizedCongressTrade => row != null),
    );
    // Short page = no more history for this ticker.
    if (rows.length < size) break;
  }
  return out;
}

/** Memoised per ticker so the crawl is incremental and a refresh never blanks a name. */
function fetchTickerMemo(ticker: string, apiKey: string): Promise<NormalizedCongressTrade[]> {
  return memo(`ainvest:congress:ticker:${ticker}`, { ttlMs: TICKER_TTL_MS }, () =>
    fetchAInvestCongressTicker(ticker, apiKey),
  );
}

export type AInvestTape = {
  trades: NormalizedCongressTrade[];
  perTicker: Record<string, { count: number; error: string | null }>;
  /** True when the crawl stopped early on rate limits; the tape is partial. */
  rateLimited: boolean;
  fetchedAt: string;
};

/**
 * Merged, memoised congressional tape across the ticker universe. Every row is
 * kept — tradability is decided downstream — so a filer's book shows every
 * name they disclosed, not only the ones we can route.
 */
export async function fetchAInvestCongressTape(tickers: readonly string[]): Promise<AInvestTape> {
  const apiKey = ainvestApiKey();
  if (!apiKey) {
    throw new AInvestError(4010, "AINVEST_API_KEY is not set");
  }
  const key = `ainvest:congress:tape:${tickers.length}:${[...tickers].sort().join(",").length}`;
  return memo(key, { ttlMs: TAPE_TTL_MS }, async () => {
    const perTicker: AInvestTape["perTicker"] = {};
    let authFailure: AInvestError | null = null;
    let consecutiveRateLimits = 0;
    let rateLimited = false;
    const batches = await mapLimit(tickers, TICKER_CONCURRENCY, async (ticker) => {
      if (authFailure || rateLimited) {
        perTicker[ticker] = { count: 0, error: "skipped" };
        return [] as NormalizedCongressTrade[];
      }
      try {
        const trades = await fetchTickerMemo(ticker, apiKey);
        perTicker[ticker] = { count: trades.length, error: null };
        consecutiveRateLimits = 0;
        return trades;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        perTicker[ticker] = { count: 0, error: message };
        if (isAuthFailure(error)) authFailure = error as AInvestError;
        if (isRateLimit(error)) {
          consecutiveRateLimits += 1;
          if (consecutiveRateLimits >= RATE_LIMIT_PATIENCE) rateLimited = true;
        }
        return [] as NormalizedCongressTrade[];
      }
    });
    if (authFailure) throw authFailure;

    const seen = new Set<string>();
    const trades = batches
      .flat()
      .filter((trade) => {
        if (seen.has(trade.id)) return false;
        seen.add(trade.id);
        return true;
      })
      .sort((a, b) => +new Date(b.filingDate) - +new Date(a.filingDate));

    if (trades.length === 0 && Object.values(perTicker).every((entry) => entry.error)) {
      throw new Error(rateLimited ? "AInvest rate limited before any ticker answered" : "AInvest unreachable for every ticker");
    }
    return { trades, perTicker, rateLimited, fetchedAt: new Date().toISOString() };
  });
}
