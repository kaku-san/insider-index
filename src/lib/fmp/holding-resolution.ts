import { normalizeTicker, preferredToken, type CatalogIndex } from "../venues/catalog-parse.ts";
import type { Activity, Batch, DisclosedItem, SourceRow } from "./types.ts";

/** Exact issuer identity after formatting/legal suffixes, never fuzzy substring matching.
 * Account prefixes are not the security; share classes and fund strategy words stay significant.
 */
export function holdingName(name: string | null): string {
  return (name ?? "").split("⇒").at(-1)!.replace(/\[(ST|EF)\]/gi, "")
    .replace(/\([A-Z][A-Z0-9.-]{0,14}\)/g, "").replace(/\bcommon stock\b/gi, "")
    .toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9 ]/g, " ")
    .replace(/\b(incorporated|inc|corporation|corp|limited|ltd|company|co)\b/g, " ")
    .replace(/\s+/g, " ").trim();
}
export function holdingSymbolHint(name: string | null): string | null {
  const hints = [...(name ?? "").matchAll(/\(([A-Z][A-Z0-9.-]{0,14})\)/g)].map((m) => normalizeTicker(m[1]));
  return hints.length === 1 ? hints[0] : null;
}
export function holdingSearchQuery(name: string | null): string {
  return holdingName(name).replace(/\b(class|series) [a-z0-9]+\b/g, "").replace(/\s+/g, " ").trim();
}
/** Search transport text preserves issuer punctuation (Amazon.com), unlike identity normalization. */
export function holdingSearchText(name: string | null): string {
  return (name ?? "").split("⇒").at(-1)!.replace(/\[(ST|EF)\]/gi, "")
    .replace(/\([A-Z][A-Z0-9.-]{0,14}\)/g, "").replace(/\bcommon stock\b/gi, "")
    .replace(/\b(class|series) [a-z0-9]+\b/gi, "")
    .replace(/\b(incorporated|inc|corporation|corp|limited|ltd|company|co)\b\.?/gi, "")
    .replace(/\s+/g, " ").replace(/^[\s,.-]+|[\s,.-]+$/g, "").trim().toLowerCase().slice(0, 200);
}
export function matchesHoldingName(name: string | null, candidate: string | null, symbol: string): boolean {
  const hint = holdingSymbolHint(name);
  if (hint && hint !== normalizeTicker(symbol)) return false;
  const exact = holdingName(name), other = holdingName(candidate);
  return !!exact && (exact === other || (!!hint && holdingSearchQuery(name) === other));
}
export type HoldingResolution = {
  holding: DisclosedItem;
  ticker: string | null;
  method: "source-symbol" | "person-trade-symbol" | "fmp-exact-name" | "unresolved";
  reason: string | null;
  candidates: SourceRow[];
  searchComplete: boolean;
  tradeIds: string[];
  token: ReturnType<typeof preferredToken>;
};
export function resolveHolding(holding: DisclosedItem, trades: readonly Activity[], search: Batch | null, catalog: CatalogIndex): HoldingResolution {
  const result: HoldingResolution = { holding, ticker: null, method: "unresolved", reason: "unresolved-security", candidates: search?.rows ?? [], searchComplete: search?.complete ?? false, tradeIds: [], token: null };
  if (!["stock", "etf"].includes(holding.kind)) return { ...result, reason: "ineligible-instrument" };
  const name = holdingName(holding.name);
  const matching = trades.filter((t) => t.personId === holding.personId && t.kind === holding.kind && t.ticker && name && matchesHoldingName(holding.name, t.name, t.ticker));
  const symbols = [...new Set(matching.map((t) => normalizeTicker(t.ticker!)))];
  if (holding.ticker) { result.ticker = normalizeTicker(holding.ticker); result.method = "source-symbol"; }
  else if (symbols.length === 1) {
    result.ticker = symbols[0]; result.method = "person-trade-symbol"; result.tradeIds = matching.map((t) => t.id).sort();
  } else if (symbols.length > 1) return { ...result, reason: "ambiguous-person-symbols" };
  else if (search?.complete && name) {
    const candidates = search.rows.filter(({ row }) => typeof row.name === "string" &&
      typeof row.symbol === "string" && /^[A-Z][A-Z0-9.-]{0,14}$/.test(row.symbol) && matchesHoldingName(holding.name, row.name, row.symbol) &&
      ["NASDAQ", "NYSE", "AMEX"].includes(String(row.exchangeShortName ?? row.exchange)) && row.currency === "USD");
    const tickers = [...new Set(candidates.map(({ row }) => normalizeTicker(String(row.symbol))))];
    if (tickers.length === 1) { result.ticker = tickers[0]; result.method = "fmp-exact-name"; }
    else if (tickers.length > 1) return { ...result, reason: "ambiguous-search-symbols" };
  }
  result.token = result.ticker ? preferredToken(catalog, result.ticker) : null;
  result.reason = result.ticker ? result.token ? null : "no-solana-mint" : "unresolved-security";
  return result;
}
