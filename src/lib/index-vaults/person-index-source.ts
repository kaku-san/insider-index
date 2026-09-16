/**
 * Pure normaliser from the committed FMP-holdings source bucket into `PersonBook`s, plus the
 * all-people derivation. No fetch, no env, no path aliases: callers pass parsed JSON and a catalog.
 *
 * The bucket is `data/insiderindex-source-buckets/pelositracker-fmp-latest-top20/` (holdings kept
 * verbatim from the captain drop, versioned by the source zip `sha256` in its MANIFEST).
 */
import type { CatalogIndex } from "../venues/catalog-parse.ts";
import type { PoolEvidenceSource } from "./pool-evidence.ts";
import { derivePersonIndex, type PersonBook, type PersonIndexDefinition } from "./person-index-map.ts";

export type RawHoldingsFile = {
  slug?: string;
  bioguideId?: string | null;
  name?: string | null;
  party?: string | null;
  state?: string | null;
  title?: string | null;
  fmpYear?: number | null;
  bookSource?: string | null;
  annualFetchComplete?: boolean | null;
  holdings?: unknown;
  holdingsFromTransactions?: unknown;
};

function asHoldings(value: unknown): PersonBook["holdings"] {
  if (!Array.isArray(value)) return [];
  return value.map((row) => {
    const r = (row ?? {}) as Record<string, unknown>;
    const range = r.valueRange as Record<string, unknown> | null | undefined;
    return {
      name: typeof r.name === "string" ? r.name : null,
      ticker: typeof r.ticker === "string" ? r.ticker : null,
      section: typeof r.section === "string" ? r.section : null,
      value: typeof r.value === "number" ? r.value : null,
      valueRange: range && typeof range === "object"
        ? { min: typeof range.min === "number" ? range.min : null, max: typeof range.max === "number" ? range.max : null }
        : null,
    };
  });
}

function asTxnHoldings(value: unknown): PersonBook["holdingsFromTransactions"] {
  if (!Array.isArray(value)) return [];
  return value.map((row) => {
    const r = (row ?? {}) as Record<string, unknown>;
    return {
      ticker: typeof r.ticker === "string" ? r.ticker : null,
      name: typeof r.name === "string" ? r.name : null,
      tradeCount: typeof r.tradeCount === "number" ? r.tradeCount : null,
      sides: Array.isArray(r.sides) ? (r.sides as string[]) : null,
      note: typeof r.note === "string" ? r.note : null,
    };
  });
}

export function toPersonBook(raw: RawHoldingsFile): PersonBook {
  if (!raw || typeof raw.slug !== "string") throw new Error("Holdings file needs a slug");
  return {
    slug: raw.slug,
    bioguideId: raw.bioguideId ?? null,
    name: typeof raw.name === "string" ? raw.name : raw.slug,
    party: raw.party ?? null,
    state: raw.state ?? null,
    title: raw.title ?? null,
    fmpYear: typeof raw.fmpYear === "number" ? raw.fmpYear : null,
    bookSource: raw.bookSource ?? null,
    annualFetchComplete: typeof raw.annualFetchComplete === "boolean" ? raw.annualFetchComplete : null,
    holdings: asHoldings(raw.holdings),
    holdingsFromTransactions: asTxnHoldings(raw.holdingsFromTransactions),
  };
}

export function deriveAllPersonIndexes(
  books: readonly PersonBook[],
  catalog: CatalogIndex,
  poolSource: PoolEvidenceSource,
): PersonIndexDefinition[] {
  return books
    .map((book) => derivePersonIndex(book, catalog, poolSource))
    .sort((a, b) => a.slug.localeCompare(b.slug));
}
