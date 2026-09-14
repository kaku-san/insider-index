/**
 * SEC EDGAR Form 4 adapter — primary insider source. No API key.
 *
 * ticker → CIK (company_tickers.json, with a pinned fallback for the xStock
 * allowlist) → data.sec.gov/submissions → recent `4` filings → ownershipDocument
 * XML → open-market P/S rows.
 *
 * SEC fair-access rules: descriptive User-Agent, ≤10 req/s. Every network call
 * goes through one global pacer; filing XML is immutable and memoised for the
 * life of the process; submissions and the merged tape refresh every 10 min
 * with stale-while-revalidate so a warm server never blocks a render.
 */

import { ALLOWLISTED_TICKERS } from "@/lib/allowlist";
import { globalState, mapLimit, memo } from "@/lib/cache";
import {
  buildTickerCikMap,
  edgarDocumentUrl,
  form4ToTransactions,
  padCik,
  parseForm4Xml,
  selectRecentForm4Filings,
  type EdgarFilingRef,
  type EdgarSubmissions,
} from "@/lib/disclosures/edgar-parse";
import type { Form4Transaction } from "@/lib/disclosures/types";
import { edgarUserAgent } from "@/lib/runtime";

const COMPANY_TICKERS_URL = "https://www.sec.gov/files/company_tickers.json";
const SUBMISSIONS_BASE = "https://data.sec.gov/submissions";

/** Pinned CIKs for the allowlist so a company_tickers.json outage cannot blank the tape. */
export const PINNED_CIKS: Record<string, string> = {
  NVDA: "0001045810",
  AAPL: "0000320193",
  TSLA: "0001318605",
  MSFT: "0000789019",
  META: "0001326801",
  AMZN: "0001018724",
  GOOGL: "0001652044",
  GOOG: "0001652044",
  NFLX: "0001065280",
  COIN: "0001679788",
  MSTR: "0001050446",
  // ETFs (SPY, QQQ) file no Form 4s; excluded on purpose.
};

const FILINGS_PER_TICKER = Math.max(1, Number(process.env.EDGAR_FILINGS_PER_TICKER ?? 20) || 20);
const DOC_CONCURRENCY = 4;
const TICKER_CONCURRENCY = 3;
const REFRESH_TTL_MS = 10 * 60_000;
const FOREVER = Number.POSITIVE_INFINITY;

/** Global pacing: SEC allows 10 req/s per client. Space network calls ≥110 ms apart. */
const MIN_GAP_MS = 110;
const pacer = globalState("edgar_pacer", () => ({ nextSlot: 0 }));
async function throttle(): Promise<void> {
  const now = Date.now();
  const slot = Math.max(now, pacer.nextSlot);
  pacer.nextSlot = slot + MIN_GAP_MS;
  if (slot > now) {
    await new Promise((resolve) => setTimeout(resolve, slot - now));
  }
}

async function edgarFetch(url: string): Promise<Response> {
  await throttle();
  const response = await fetch(url, {
    headers: {
      "User-Agent": edgarUserAgent(),
      Accept: url.endsWith(".json") ? "application/json" : "application/xml,text/xml,*/*",
    },
    // We memoise in-process; keep Next's data cache out of the loop so the
    // pacer only ever counts real network calls.
    cache: "no-store",
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    throw new Error(`EDGAR ${response.status} for ${url}`);
  }
  return response;
}

export async function resolveCik(ticker: string): Promise<string | null> {
  const symbol = ticker.trim().toUpperCase();
  const pinned = PINNED_CIKS[symbol];
  if (pinned) return pinned;
  const map = await memo("edgar:tickers", { ttlMs: 6 * 3_600_000 }, async () => {
    const response = await edgarFetch(COMPANY_TICKERS_URL);
    return buildTickerCikMap(
      (await response.json()) as Record<string, { cik_str: number; ticker: string; title: string }>,
    );
  }).catch(() => new Map<string, { cik: string; title: string }>());
  return map.get(symbol)?.cik ?? null;
}

export async function fetchSubmissions(cik: string): Promise<EdgarSubmissions> {
  const padded = padCik(cik);
  return memo(`edgar:submissions:${padded}`, { ttlMs: REFRESH_TTL_MS }, async () => {
    const response = await edgarFetch(`${SUBMISSIONS_BASE}/CIK${padded}.json`);
    return (await response.json()) as EdgarSubmissions;
  });
}

export async function fetchForm4Document(ref: EdgarFilingRef): Promise<string> {
  const url = edgarDocumentUrl(ref);
  return memo(`edgar:doc:${url}`, { ttlMs: FOREVER }, async () => {
    const response = await edgarFetch(url);
    return response.text();
  });
}

export type EdgarIssuerResult = {
  cik: string;
  tickers: string[];
  filingsScanned: number;
  transactions: Form4Transaction[];
  error: string | null;
};

/**
 * Crawl the most recent Form 4 filings for one issuer (CIK) and return P/S
 * rows. `tickers` are the allowlisted symbols sharing that CIK (GOOG/GOOGL);
 * the filing's own trading symbol wins when it is one of them.
 */
export async function fetchEdgarIssuer(
  cik: string,
  tickers: readonly string[],
  options: { filings?: number; codes?: readonly string[] } = {},
): Promise<EdgarIssuerResult> {
  const group = tickers.map((ticker) => ticker.trim().toUpperCase());
  try {
    const submissions = await fetchSubmissions(cik);
    const refs = selectRecentForm4Filings(
      { ...submissions, cik },
      options.filings ?? FILINGS_PER_TICKER,
    );
    const batches = await mapLimit(refs, DOC_CONCURRENCY, async (ref) => {
      try {
        const parsed = parseForm4Xml(await fetchForm4Document(ref));
        const symbol = group.includes(parsed.issuerTicker) ? parsed.issuerTicker : group[0];
        return form4ToTransactions(parsed, ref, { ticker: symbol, codes: options.codes });
      } catch {
        return [] as Form4Transaction[];
      }
    });
    return { cik, tickers: group, filingsScanned: refs.length, transactions: batches.flat(), error: null };
  } catch (error) {
    return {
      cik,
      tickers: group,
      filingsScanned: 0,
      transactions: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export type EdgarTape = {
  transactions: Form4Transaction[];
  perTicker: Record<string, { cik: string | null; filingsScanned: number; count: number; error: string | null }>;
  fetchedAt: string;
};

/** Merged, memoised P/S tape across every allowlisted underlying. */
export async function fetchEdgarTape(tickers: readonly string[] = ALLOWLISTED_TICKERS): Promise<EdgarTape> {
  const symbols = [...new Set(tickers.map((ticker) => ticker.trim().toUpperCase()))].sort();
  const key = `edgar:tape:${symbols.join(",")}`;
  return memo(key, { ttlMs: REFRESH_TTL_MS }, async () => {
    const perTicker: EdgarTape["perTicker"] = {};
    const byCik = new Map<string, string[]>();
    for (const symbol of symbols) {
      const cik = await resolveCik(symbol);
      if (!cik) {
        perTicker[symbol] = { cik: null, filingsScanned: 0, count: 0, error: "no CIK" };
        continue;
      }
      byCik.set(cik, [...(byCik.get(cik) ?? []), symbol]);
    }

    const results = await mapLimit([...byCik.entries()], TICKER_CONCURRENCY, ([cik, group]) =>
      fetchEdgarIssuer(cik, group),
    );
    for (const result of results) {
      for (const symbol of result.tickers) {
        perTicker[symbol] = {
          cik: result.cik,
          filingsScanned: result.filingsScanned,
          count: result.transactions.filter((row) => row.ticker === symbol).length,
          error: result.error,
        };
      }
    }
    const transactions = results
      .flatMap((result) => result.transactions)
      .sort((a, b) => +new Date(b.filedAt || b.transactionDate) - +new Date(a.filedAt || a.transactionDate));
    if (transactions.length === 0 && results.length > 0 && results.every((result) => result.error)) {
      throw new Error("EDGAR unreachable for every issuer");
    }
    return { transactions, perTicker, fetchedAt: new Date().toISOString() };
  });
}

/** Kick off the crawl without awaiting it (server warm-up). */
export function warmEdgarTape(): void {
  void fetchEdgarTape().catch(() => undefined);
}
