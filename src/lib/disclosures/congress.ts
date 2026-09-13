/**
 * Form4API Congress adapter (STOCK Act PTRs).
 *
 * Live path: GET https://api.form4api.com/v1/congress/trades
 * Fields we rely on: politician.{bioguideId,slug,fullName,party,chamber,state},
 * ticker, assetName, transactionType, amountLow, amountHigh, transactionDate,
 * disclosureDate. Coverage is House-first. Party is free-text (D / Democratic).
 *
 * Without FORM4API_KEY, or on 402/plan errors, we serve mock House trades.
 */

import { getXStockByTicker } from "@/lib/allowlist";
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
  const ticker = (trade.ticker ?? "").toUpperCase();
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
  const shares = price ? Math.round(value / price) : 0;
  const disclosed = "disclosureDate" in trade ? trade.disclosureDate : undefined;
  const transacted = "transactionDate" in trade ? trade.transactionDate : "";

  return {
    id:
      ("id" in trade && trade.id) ||
      `cng-${bioguide}-${ticker}-${String(disclosed ?? transacted).slice(0, 10)}`,
    accessionNumber: `PTR-${bioguide}`,
    ticker,
    issuerName: ("assetName" in trade && trade.assetName) || ticker,
    insiderName: name,
    insiderTitle: [politician.chamber, politician.state, party].filter(Boolean).join(" · "),
    insiderCik: bioguide,
    transactionCode: side === "sell" ? "S" : "P",
    transactionDate: String(transacted ?? ""),
    filedAt: String(disclosed ?? transacted ?? ""),
    sharesAmount: shares,
    pricePerShare: price,
    transactionValue: value,
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

export async function listCongressDisclosures(): Promise<Disclosure[]> {
  const apiKey = process.env.FORM4API_KEY;
  if (!apiKey) {
    return listMockCongressDisclosures();
  }

  try {
    const response = await fetch(`${FORM4_API_BASE}/v1/congress/trades?per_page=100`, {
      headers: { "X-Api-Key": apiKey },
      next: { revalidate: 60 },
    });
    if (!response.ok) {
      return listMockCongressDisclosures();
    }
    const payload = (await response.json()) as CongressApiTrade[] | { data?: CongressApiTrade[] };
    const rows = Array.isArray(payload) ? payload : (payload.data ?? []);
    if (rows.length === 0) {
      return listMockCongressDisclosures();
    }
    return rows.map((row) => congressTradeToDisclosure(row, "congress"));
  } catch {
    return listMockCongressDisclosures();
  }
}

export async function fetchCongressTrades(): Promise<Disclosure[]> {
  return listCongressDisclosures();
}
