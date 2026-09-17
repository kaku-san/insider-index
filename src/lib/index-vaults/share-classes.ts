/**
 * Curated same-company share-class equivalences for the index-vault derivation.
 *
 * A US dual/multi-class listing (e.g. Alphabet's GOOGL Class A and GOOG Class C) is TWO tickers
 * that route to two different Solana mints yet represent ONE underlying company. Left alone, an
 * index basket can carry the same company twice — once behind a tradable xStock and once behind an
 * illiquid Backpack `.US` duplicate — so its "missing" leg is really a duplicate of a name already
 * present. The derivation collapses these into a single leg deliberately (see
 * `buildWeightedIndexDefinition`); this module is the honest, non-inventive equivalence table it
 * consults.
 *
 * Only unambiguous, well-documented same-company US share classes belong here. Never map two
 * distinct companies together. Pure: no env, no fetch, no path aliases.
 */
import { normalizeTicker } from "../venues/catalog-parse.ts";

/**
 * Each group is one company's set of publicly-listed share-class tickers (normalised form). The
 * first entry is the canonical underlying id used to key the group.
 */
const SHARE_CLASS_GROUPS: readonly (readonly string[])[] = [
  ["GOOGL", "GOOG"], // Alphabet — Class A (GOOGL) and Class C (GOOG)
  ["BRK.A", "BRK.B"], // Berkshire Hathaway
  ["FOXA", "FOX"], // Fox Corporation — Class A / Class B
  ["NWSA", "NWS"], // News Corporation — Class A / Class B
  ["UAA", "UA"], // Under Armour — Class A / Class C
];

const CANONICAL_BY_TICKER: ReadonlyMap<string, string> = (() => {
  const map = new Map<string, string>();
  for (const group of SHARE_CLASS_GROUPS) {
    const canonical = group[0];
    for (const ticker of group) map.set(normalizeTicker(ticker), normalizeTicker(canonical));
  }
  return map;
})();

/**
 * The canonical underlying id for a ticker. For a known share-class member this is the company's
 * canonical ticker (so GOOG and GOOGL collapse to the same key); for every other ticker it is the
 * normalised ticker itself. This is the equality test the duplicate-underlying guard keys on.
 */
export function canonicalUnderlying(ticker: string): string {
  const normalized = normalizeTicker(ticker);
  return CANONICAL_BY_TICKER.get(normalized) ?? normalized;
}
