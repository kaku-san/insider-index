import { address } from "./amounts.ts";
import { assertNoPythEnvironment, raydiumPoolFor, type RaydiumPoolBinding } from "./raydium-oracles.ts";

/** Zap/eligibility quotes: Raydium pool first, Jupiter if no pool. Never Pyth/Hermes. Native `update_token_prices` stays Raydium-only. */
export type QuoteVenue = "raydium" | "jupiter";
export interface VenueQuote {
  mint: string;
  venue: QuoteVenue;
  inMint: string;
  outMint: string;
  inAmountRaw: string;
  outAmountRaw: string;
}
const FORBIDDEN_HOST = /(^|\.)(hermes|pyth)(\.|$)|pyth\.network|pythdata|pythnet/i;

export function assertAllowedPriceUrl(url: string): URL {
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error(`PRICE_URL_INVALID: ${url}`); }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error(`PRICE_URL_INVALID: ${url}`);
  if (FORBIDDEN_HOST.test(parsed.hostname)) throw new Error(`HERMES_PYTH_FORBIDDEN: ${parsed.hostname}`);
  return parsed;
}

/** Drop-in fetch that fails before any Hermes/Pyth host is contacted. */
export function priceFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  assertNoPythEnvironment();
  assertAllowedPriceUrl(String(input));
  return fetch(input, init);
}

export function selectQuoteVenue(mint: string, bindings: readonly RaydiumPoolBinding[]): QuoteVenue {
  address(mint);
  try { raydiumPoolFor(mint, bindings); return "raydium"; }
  catch (error) {
    if (error instanceof Error && error.message.startsWith("RAYDIUM_POOL_REQUIRED")) return "jupiter";
    throw error;
  }
}

export function assertQuoteVenue(quote: Pick<VenueQuote, "venue">): void {
  if (quote.venue !== "raydium" && quote.venue !== "jupiter") throw new Error(`PRICE_SOURCE_FORBIDDEN: ${String((quote as { venue: unknown }).venue)}`);
}

export function requireQuotes(mints: string[], quotes: readonly VenueQuote[]): Map<string, VenueQuote> {
  const map = new Map<string, VenueQuote>();
  for (const quote of quotes) {
    assertQuoteVenue(quote);
    const mint = address(quote.mint);
    if (map.has(mint)) throw new Error(`Duplicate quote for ${mint}`);
    map.set(mint, quote);
  }
  for (const mint of mints) {
    if (!map.has(address(mint))) throw new Error(`ZAP_QUOTE_REQUIRED: ${mint}`);
  }
  return map;
}
