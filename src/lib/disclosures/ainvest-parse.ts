/**
 * Pure parsers for the AInvest Congressional Trades API.
 * https://docs.ainvest.com/reference/ownership/congress
 *
 * GET https://openapi.ainvest.com/open/ownership/congress?ticker=NVDA&page=1&size=50
 * Authorization: Bearer <AINVEST_API_KEY>
 *
 * The envelope is always HTTP 200; errors are signalled by a non-zero
 * `status_code`. Rows do not repeat the ticker (it is the query param), and
 * carry no bioguide id or chamber — we never invent those.
 */

export type AInvestCongressRow = {
  name?: string;
  party?: string;
  state?: string;
  trade_date?: string;
  filing_date?: string;
  reporting_gap?: string;
  trade_type?: string;
  size?: string;
};

export type AInvestEnvelope<T> = {
  data?: { data?: T[] } | T[] | null;
  status_code?: number;
  status_msg?: string;
};

export class AInvestError extends Error {
  readonly statusCode: number;
  constructor(statusCode: number, message: string) {
    super(`AInvest ${statusCode}: ${message}`);
    this.name = "AInvestError";
    this.statusCode = statusCode;
  }
}

/** Unwrap the standard envelope; throws AInvestError on a non-zero status. */
export function unwrapAInvestEnvelope<T>(payload: AInvestEnvelope<T>): T[] {
  const status = Number(payload.status_code ?? 0);
  if (status !== 0) {
    throw new AInvestError(status, payload.status_msg ?? "unknown error");
  }
  const data = payload.data;
  if (!data) return [];
  if (Array.isArray(data)) return data;
  return Array.isArray(data.data) ? data.data : [];
}

const SUFFIX: Record<string, number> = { K: 1e3, M: 1e6, B: 1e9 };

function parseMoney(token: string): number | null {
  const match = /^\$?\s*([\d,]+(?:\.\d+)?)\s*([KMB])?$/i.exec(token.trim());
  if (!match) return null;
  const base = Number(match[1].replace(/,/g, ""));
  if (!Number.isFinite(base)) return null;
  const multiplier = match[2] ? SUFFIX[match[2].toUpperCase()] : 1;
  return Math.round(base * multiplier);
}

export type SizeRange = { low: number | null; high: number | null };

/**
 * STOCK Act size buckets come as strings: "$1K-$15K", "$100K-$250K",
 * "$1M-$5M", "$50M+", "Over $50,000,000", "$1,001 - $15,000". Returns null
 * bounds when unparseable — never a fake 0.
 */
export function parseTradeSize(size: string | null | undefined): SizeRange {
  if (!size) return { low: null, high: null };
  const text = size.replace(/[\u2013\u2014]/g, "-").trim();
  const tokens = (text.match(/\$?\s*\d[\d,]*(?:\.\d+)?\s*[KMB]?/gi) ?? [])
    .map((token) => parseMoney(token))
    .filter((value): value is number => value != null);

  if (tokens.length >= 2) {
    return { low: Math.min(tokens[0], tokens[1]), high: Math.max(tokens[0], tokens[1]) };
  }
  if (tokens.length === 1) {
    if (/over|more than|greater|\+|>/i.test(text)) return { low: tokens[0], high: null };
    if (/under|less than|up to|<|below/i.test(text)) return { low: null, high: tokens[0] };
    return { low: tokens[0], high: tokens[0] };
  }
  return { low: null, high: null };
}

export function slugifyName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\b(Hon\.?|Rep\.?|Sen\.?|Mr\.?|Mrs\.?|Ms\.?|Dr\.?|Jr\.?|Sr\.?|III|II)\b/gi, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export type NormalizedCongressTrade = {
  id: string;
  ticker: string;
  name: string;
  slug: string;
  party: string | null;
  state: string | null;
  side: "buy" | "sell" | "other";
  tradeDate: string;
  filingDate: string;
  reportingGap: string | null;
  amountLow: number | null;
  amountHigh: number | null;
  sizeLabel: string | null;
};

export function congressSideFromType(type: string | null | undefined): "buy" | "sell" | "other" {
  const value = (type ?? "").trim().toLowerCase();
  if (!value) return "other";
  if (value === "buy" || value === "purchase" || value.startsWith("purchase") || value.startsWith("buy")) return "buy";
  if (value === "sell" || value.startsWith("sale") || value.startsWith("sell") || value.includes("exchange")) return "sell";
  return "other";
}

function isoDate(value: string | undefined): string {
  const raw = (value ?? "").trim();
  if (!raw) return "";
  // Accept YYYY-MM-DD, MM/DD/YYYY, or full ISO.
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(raw);
  if (us) {
    return `${us[3]}-${us[1].padStart(2, "0")}-${us[2].padStart(2, "0")}`;
  }
  return raw.slice(0, 10);
}

/** Normalise one AInvest row for `ticker`. Returns null when the row is unusable. */
export function normalizeAInvestCongressRow(
  row: AInvestCongressRow,
  ticker: string,
): NormalizedCongressTrade | null {
  const name = (row.name ?? "").trim();
  const symbol = ticker.trim().toUpperCase();
  if (!name || !symbol) return null;
  const side = congressSideFromType(row.trade_type);
  const { low, high } = parseTradeSize(row.size);
  const tradeDate = isoDate(row.trade_date);
  const filingDate = isoDate(row.filing_date) || tradeDate;
  const slug = slugifyName(name);
  return {
    id: `ainvest-${slug}-${symbol}-${tradeDate || "nd"}-${side}${low != null ? `-${low}` : ""}`,
    ticker: symbol,
    name,
    slug,
    party: row.party?.trim() || null,
    state: row.state?.trim().toUpperCase() || null,
    side,
    tradeDate,
    filingDate,
    reportingGap: row.reporting_gap?.trim() || null,
    amountLow: low,
    amountHigh: high,
    sizeLabel: row.size?.trim() || null,
  };
}
