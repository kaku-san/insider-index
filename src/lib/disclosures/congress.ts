/**
 * Congress (STOCK Act PTR) lane — House and Senate.
 *
 * Order of preference:
 *  1. AInvest Congressional Trades (`ainvest-congress`) — primary, AINVEST_API_KEY
 *  2. Form4API House PTRs (`congress`) — fallback only when FORM4API_KEY is set
 *  3. Mock fixtures (`mock-congress`) — dev only (STOCKLANA_ALLOW_MOCKS)
 *
 * Only allowlisted xStock underlyings are queried, so every row is a real
 * politician trading a copyable name. PTRs disclose dollar ranges, not share
 * counts or prices: sharesAmount / pricePerShare stay null and the UI renders
 * null as "—", never 0. transactionValue is the range midpoint.
 */

import { ALLOWLISTED_TICKERS, getXStockByTicker } from "@/lib/allowlist";
import { fetchAInvestCongressTape } from "@/lib/disclosures/ainvest";
import type { NormalizedCongressTrade } from "@/lib/disclosures/ainvest-parse";
import { MOCK_CONGRESS_TRADES, type MockCongressTrade } from "@/lib/disclosures/mock-congress";
import type { Disclosure, DisclosureSide, LaneStatus } from "@/lib/disclosures/types";
import { normalizeParty } from "@/lib/fomo/party";
import { mocksAllowed } from "@/lib/runtime";

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
    amountLow != null && amountHigh != null ? midpoint(amountLow, amountHigh) : (amountLow ?? null);
  const bioguide = politician.bioguideId ?? "unknown";
  const name = politician.fullName ?? "Unknown member";
  const party = normalizeParty(politician.party ?? null);
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
    // PTRs disclose a dollar range only. No share count, no price — never 0.
    sharesAmount: null,
    pricePerShare: null,
    transactionValue: value && value > 0 ? value : null,
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

/** AInvest rows carry no bioguide id or chamber; we key profiles by name slug. */
export function ainvestTradeToDisclosure(trade: NormalizedCongressTrade): Disclosure {
  const xstock = getXStockByTicker(trade.ticker);
  const party = normalizeParty(trade.party);
  const value =
    trade.amountLow != null && trade.amountHigh != null
      ? midpoint(trade.amountLow, trade.amountHigh)
      : trade.amountLow;
  const filedAt = trade.filingDate ? `${trade.filingDate}T00:00:00.000Z` : "";

  return {
    id: trade.id,
    accessionNumber: `PTR-${trade.slug}`,
    ticker: trade.ticker,
    issuerName: xstock?.name.replace(/ xStock$/, "") ?? trade.ticker,
    insiderName: trade.name,
    insiderTitle: [trade.state, party, trade.sizeLabel].filter(Boolean).join(" · "),
    insiderCik: trade.slug,
    transactionCode: trade.side === "sell" ? "S" : "P",
    transactionDate: trade.tradeDate,
    filedAt,
    sharesAmount: null,
    pricePerShare: null,
    transactionValue: value != null && value > 0 ? value : null,
    sharesOwnedAfter: null,
    is10b51: false,
    source: "ainvest-congress",
    side: trade.side,
    xstockSymbol: xstock?.symbol ?? null,
    xstockMint: xstock?.mint ?? null,
    tradeEligible: Boolean(xstock) && (trade.side === "buy" || trade.side === "sell"),
    kind: "politician",
    profileId: `pol-${trade.slug}`,
    party,
    chamber: null,
    state: trade.state,
    amountLow: trade.amountLow,
    amountHigh: trade.amountHigh,
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
    next: { revalidate: 300 },
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

function sortNewest(rows: Disclosure[]): Disclosure[] {
  return [...rows].sort((a, b) => +new Date(b.filedAt) - +new Date(a.filedAt));
}

async function fetchForm4ApiCongress(apiKey: string): Promise<Disclosure[]> {
  const perTicker = await Promise.all(
    ALLOWLISTED_TICKERS.map(async (ticker) => {
      try {
        return await fetchCongressPage(apiKey, { ticker, per_page: "25", page: "1" });
      } catch {
        return [] as CongressApiTrade[];
      }
    }),
  );
  return sortNewest(
    dedupeCongress(
      perTicker
        .flat()
        .filter((row) => Boolean(row.ticker?.trim()))
        .map((row) => congressTradeToDisclosure(row, "congress")),
    ).filter((row) => Boolean(getXStockByTicker(row.ticker))),
  );
}

export type CongressTape = {
  rows: Disclosure[];
  status: LaneStatus;
};

export async function listCongressTape(): Promise<CongressTape> {
  const notes: string[] = [];

  if (process.env.AINVEST_API_KEY?.trim()) {
    try {
      const tape = await fetchAInvestCongressTape(ALLOWLISTED_TICKERS);
      const rows = sortNewest(
        dedupeCongress(tape.trades.map(ainvestTradeToDisclosure)).filter((row) =>
          Boolean(row.ticker && getXStockByTicker(row.ticker)),
        ),
      );
      const failing = Object.entries(tape.perTicker)
        .filter(([, entry]) => entry.error)
        .map(([ticker]) => ticker);
      if (rows.length > 0) {
        return {
          rows,
          status: {
            source: "ainvest-congress",
            live: true,
            count: rows.length,
            note: failing.length ? `AInvest errors for ${failing.join(", ")}` : null,
          },
        };
      }
      notes.push("AInvest returned no rows for allowlisted tickers");
    } catch (error) {
      notes.push(`AInvest: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else {
    notes.push("AINVEST_API_KEY not set");
  }

  const form4ApiKey = process.env.FORM4API_KEY?.trim();
  if (form4ApiKey) {
    try {
      const rows = await fetchForm4ApiCongress(form4ApiKey);
      if (rows.length > 0) {
        return {
          rows,
          status: { source: "congress", live: true, count: rows.length, note: notes.join("; ") || null },
        };
      }
      notes.push("Form4API congress returned no allowlisted rows");
    } catch (error) {
      notes.push(`Form4API: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (mocksAllowed()) {
    const rows = sortNewest(listMockCongressDisclosures());
    return {
      rows,
      status: {
        source: "mock-congress",
        live: false,
        count: rows.length,
        note: [...notes, "serving labelled fixtures (STOCKLANA_ALLOW_MOCKS)"].join("; "),
      },
    };
  }

  return {
    rows: [],
    status: { source: "off", live: false, count: 0, note: notes.join("; ") || "no congress source available" },
  };
}

export async function listCongressDisclosures(): Promise<Disclosure[]> {
  return (await listCongressTape()).rows;
}

export async function fetchCongressTrades(): Promise<Disclosure[]> {
  return listCongressDisclosures();
}
