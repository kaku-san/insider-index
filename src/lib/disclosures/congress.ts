/**
 * Form4API Congress adapter (STOCK Act PTRs).
 *
 * Live path: GET https://api.form4api.com/v1/congress/trades
 * Fields we rely on: politician.{bioguideId,slug,fullName,party,chamber,state},
 * ticker, assetName, transactionType, amountLow, amountHigh, transactionDate,
 * disclosureDate. Coverage is House-first. Party is free-text (D / Democratic).
 *
 * Without FORM4API_KEY, or on 402/plan errors, we serve mock House trades.
 *
 * V1 queries allowlisted xStock underlyings first so Discover shows complete,
 * copy-eligible PTRs (Pelosi/NVDA etc.) instead of a flood of empty-ticker /
 * non-allowlisted rows with null shares and prices.
 */

import { ALLOWLISTED_TICKERS, getXStockByTicker } from "@/lib/allowlist";
import { MOCK_CONGRESS_TRADES, type MockCongressTrade } from "@/lib/disclosures/mock-congress";
import type { Disclosure, DisclosureSide } from "@/lib/disclosures/types";
import { normalizeParty } from "@/lib/fomo/party";

const FORM4_API_BASE = "https://api.form4api.com";

export const CONGRESS_ADAPTER_ENABLED = true;

type CongressApiTrade = {
  politician?: {
    bioguideId?: string;
    slug?: string;
    fullName?: string;
    party?: string;
    chamber?: string;
    state?: string;
  };
  ticker?: string;
  assetName?: string;
  transactionType?: string;
  amountLow?: number;
  amountHigh?: number;
  transactionDate?: string;
  disclosureDate?: string;
  ownerType?: string;
};

function congressSide(type: string): DisclosureSide {
  const value = type.toLowerCase();
  if (value === "purchase" || value === "buy") return "buy";
  if (value.includes("sale") || value === "sell") return "sell";
  return "other";
}

function midpoint(low: number, high: number): number {
  return (low + high) / 2;
}

export function congressTradeToDisclosure(
  trade: MockCongressTrade | (CongressApiTrade & { id?: string }),
  source: Disclosure["source"],
): Disclosure {
  const politician =
    "fullName" in trade
      ? {
          bioguideId: trade.bioguideId,
          slug: trade.slug,
          fullName: trade.fullName,
          party: trade.party,
          chamber: trade.chamber,
          state: trade.state,
        }
      : (trade.politician ?? {});
  const ticker = (trade.ticker ?? "").toUpperCase().trim();
  const xstock = getXStockByTicker(ticker);
  const side = congressSide(
    "transactionType" in trade ? String(trade.transactionType) : "Purchase",
  );
  const amountLow = trade.amountLow ?? null;
  const amountHigh = trade.amountHigh ?? null;
  const value =
    amountLow != null && amountHigh != null ? midpoint(amountLow, amountHigh) : (amountLow ?? 0);
  const bioguide = politician.bioguideId ?? "unknown";
  const name = politician.fullName ?? "Unknown member";
  const party = normalizeParty(politician.party ?? null);
  const price = xstock?.stubUsdPrice ?? null;
  // Congress PTRs disclose dollar ranges, not share counts. Only estimate when
  // we have an allowlisted stub price; otherwise leave shares/price null.
  const shares = price && value > 0 ? Math.max(1, Math.round(value / price)) : null;
  const disclosed = "disclosureDate" in trade ? trade.disclosureDate : undefined;
  const transacted = "transactionDate" in trade ? trade.transactionDate : "";

  return {
    id:
      ("id" in trade && trade.id) ||
      `cng-${bioguide}-${ticker || "unk"}-${String(disclosed ?? transacted).slice(0, 10)}`,
    accessionNumber: `PTR-${bioguide}`,
    ticker,
    issuerName: ("assetName" in trade && trade.assetName) || ticker || "Unknown asset",
    insiderName: name,
    insiderTitle: [politician.chamber, politician.state, party].filter(Boolean).join(" · "),
    insiderCik: bioguide,
    transactionCode: side === "sell" ? "S" : "P",
    transactionDate: String(transacted ?? ""),
    filedAt: String(disclosed ?? transacted ?? ""),
    sharesAmount: shares,
    pricePerShare: price,
    transactionValue: value || null,
    sharesOwnedAfter: null,
    is10b51: false,
    source,
    side,
    xstockSymbol: xstock?.symbol ?? null,
    xstockMint: xstock?.mint ?? null,
    tradeEligible: Boolean(xstock) && (side === "buy" || side === "sell"),
    kind: "politician",
    profileId: `pol-${politician.slug ?? bioguide}`,
    party,
    chamber: politician.chamber ?? null,
    state: politician.state ?? null,
    amountLow,
    amountHigh,
  };
}

export function listMockCongressDisclosures(): Disclosure[] {
  return MOCK_CONGRESS_TRADES.map((trade) =>
    congressTradeToDisclosure(trade, "mock-congress"),
  );
}

async function fetchCongressPage(
  apiKey: string,
  query: Record<string, string>,
): Promise<CongressApiTrade[]> {
  const search = new URLSearchParams(query);
  const response = await fetch(`${FORM4_API_BASE}/v1/congress/trades?${search.toString()}`, {
    headers: { "X-Api-Key": apiKey },
    next: { revalidate: 60 },
  });
  if (!response.ok) {
    throw new Error(`Congress API ${response.status}`);
  }
  const payload = (await response.json()) as CongressApiTrade[] | { data?: CongressApiTrade[] };
  return Array.isArray(payload) ? payload : (payload.data ?? []);
}

function dedupeCongress(rows: Disclosure[]): Disclosure[] {
  const seen = new Set<string>();
  const out: Disclosure[] = [];
  for (const row of rows) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    out.push(row);
  }
  return out;
}

export async function listCongressDisclosures(): Promise<Disclosure[]> {
  const apiKey = process.env.FORM4API_KEY;
  if (!apiKey) {
    return listMockCongressDisclosures();
  }

  try {
    const perTicker = await Promise.all(
      ALLOWLISTED_TICKERS.map(async (ticker) => {
        try {
          return await fetchCongressPage(apiKey, {
            ticker,
            per_page: "25",
            page: "1",
          });
        } catch {
          return [] as CongressApiTrade[];
        }
      }),
    );

    let recent: CongressApiTrade[] = [];
    try {
      recent = await fetchCongressPage(apiKey, { per_page: "50", page: "1" });
    } catch {
      recent = [];
    }

    const mapped = dedupeCongress(
      [...perTicker.flat(), ...recent]
        .filter((row) => Boolean(row.ticker?.trim()))
        .map((row) => congressTradeToDisclosure(row, "congress")),
    ).filter((row) => Boolean(row.ticker));

    const allowlisted = mapped.filter((row) => Boolean(getXStockByTicker(row.ticker)));
    // Keep a small non-allowlisted slice for tape breadth, but never let it
    // drown out complete / copy-eligible prints.
    const others = mapped
      .filter((row) => !getXStockByTicker(row.ticker))
      .slice(0, 15);

    const combined = dedupeCongress([...allowlisted, ...others]).sort(
      (a, b) => +new Date(b.filedAt) - +new Date(a.filedAt),
    );

    if (combined.length === 0) {
      return listMockCongressDisclosures();
    }
    return combined;
  } catch {
    return listMockCongressDisclosures();
  }
}

export async function fetchCongressTrades(): Promise<Disclosure[]> {
  return listCongressDisclosures();
}
