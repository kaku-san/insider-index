/**
 * AInvest Congressional Trades adapter — primary House/Senate source.
 * Free tier, Bearer key from https://www.ainvest.com/business/developer-manage/
 *
 * Requires AINVEST_API_KEY. Without it this adapter is "unconfigured" and the
 * caller decides whether to fall back (Form4API) or leave the lane empty.
 */

import { ALLOWLISTED_TICKERS } from "@/lib/allowlist";
import { mapLimit, memo } from "@/lib/cache";
import {
  AInvestError,
  normalizeAInvestCongressRow,
  unwrapAInvestEnvelope,
  type AInvestCongressRow,
  type AInvestEnvelope,
  type NormalizedCongressTrade,
} from "@/lib/disclosures/ainvest-parse";

export const AINVEST_BASE = "https://openapi.ainvest.com/open";
const PAGE_SIZE = Number(process.env.AINVEST_PAGE_SIZE ?? 50) || 50;
const TAPE_TTL_MS = 15 * 60_000;

export function ainvestApiKey(): string | null {
  return process.env.AINVEST_API_KEY?.trim() || null;
}

export function ainvestConfigured(): boolean {
  return Boolean(ainvestApiKey());
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
  if (!response.ok) {
    throw new AInvestError(response.status, `HTTP ${response.status}`);
  }
  return unwrapAInvestEnvelope((await response.json()) as AInvestEnvelope<T>);
}

export async function fetchAInvestCongressTicker(
  ticker: string,
  apiKey: string,
  size = PAGE_SIZE,
): Promise<NormalizedCongressTrade[]> {
  const symbol = ticker.trim().toUpperCase();
  const rows = await ainvestGet<AInvestCongressRow>(
    "/ownership/congress",
    { ticker: symbol, page: "1", size: String(size) },
    apiKey,
  );
  return rows
    .map((row) => normalizeAInvestCongressRow(row, symbol))
    .filter((row): row is NormalizedCongressTrade => row != null);
}

export type AInvestTape = {
  trades: NormalizedCongressTrade[];
  perTicker: Record<string, { count: number; error: string | null }>;
  fetchedAt: string;
};

/** Merged, memoised congressional tape for the allowlisted underlyings. */
export async function fetchAInvestCongressTape(
  tickers: readonly string[] = ALLOWLISTED_TICKERS,
): Promise<AInvestTape> {
  const apiKey = ainvestApiKey();
  if (!apiKey) {
    throw new AInvestError(4010, "AINVEST_API_KEY is not set");
  }
  const key = `ainvest:congress:${[...tickers].sort().join(",")}`;
  return memo(key, { ttlMs: TAPE_TTL_MS }, async () => {
    const perTicker: AInvestTape["perTicker"] = {};
    let authFailure: AInvestError | null = null;
    const batches = await mapLimit(tickers, 3, async (ticker) => {
      try {
        const trades = await fetchAInvestCongressTicker(ticker, apiKey);
        perTicker[ticker] = { count: trades.length, error: null };
        return trades;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        perTicker[ticker] = { count: 0, error: message };
        // 4010 no auth / 5112 invalid key: every ticker will fail the same way.
        if (error instanceof AInvestError && (error.statusCode === 4010 || error.statusCode === 5112)) {
          authFailure = error;
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
      throw new Error("AInvest unreachable for every ticker");
    }
    return { trades, perTicker, fetchedAt: new Date().toISOString() };
  });
}
