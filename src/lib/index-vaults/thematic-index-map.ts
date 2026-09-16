/**
 * Thematic InsiderIndex vault definitions from the merged research feed.
 *
 * A thematic index is a CONSTRUCTED multi-member research basket, not one person's disclosed book.
 * It runs through the SAME weighted-definition core as the person indexes (`buildWeightedIndexDefinition`
 * in `person-index-map.ts`): identical Solana-catalog resolution (xStock → verified Backpack `.US` →
 * unmapped), the same renormalised target weights, the same Raydium pool-readiness evaluation, the
 * same native leg cap (blocks, never truncates) and the same closed-by-default deposit gate. This
 * module only supplies the thematic identity, its published constituent weights, and truthful
 * provenance that says "thematic", so the record can never read as a person index. No fork of the
 * mapping/readiness/vault-init path. Pure: no env, no fetch, no path aliases.
 */
import type { CatalogIndex } from "../venues/catalog-parse.ts";
import { listThematicViews, type ThematicIndexView } from "../thematic/views.ts";
import {
  buildWeightedIndexDefinition,
  INDEX_NETWORK,
  NATIVE_TOKEN_CAP,
  type IndexIdentity,
  type IndexProvenance,
  type PersonIndexDefinition,
} from "./person-index-map.ts";
import type { PoolEvidenceSource } from "./pool-evidence.ts";

/**
 * `IIT` + up to five uppercase alphanumerics from the thematic slug. Deterministic; ≤ 8 chars.
 * Multi-word slugs contribute from each word (3 from the first, then fill from the rest) so sibling
 * themes that share a first word (e.g. `capitol-arsenal` vs `capitol-cluster`) stay distinct.
 */
export function thematicSymbol(slug: string): string {
  const words = slug
    .replace(/^idx-theme-/, "")
    .split("-")
    .map((w) => w.toUpperCase().replace(/[^A-Z0-9]/g, ""))
    .filter(Boolean);
  let core = words[0]?.slice(0, 3) ?? "";
  for (let i = 1; i < words.length && core.length < 5; i++) core += words[i].slice(0, 5 - core.length);
  core = core.slice(0, 5) || "THEME";
  return `IIT${core}`;
}

export function deriveThematicIndex(
  view: ThematicIndexView,
  catalog: CatalogIndex,
  poolSource: PoolEvidenceSource,
): PersonIndexDefinition {
  const identity: IndexIdentity = {
    kind: "thematic",
    slug: view.slug,
    // A thematic basket is not a person: no bioguide id ever.
    bioguideId: null,
    name: view.indexName,
    indexId: view.id,
    indexName: view.indexName,
    symbol: thematicSymbol(view.slug),
    network: INDEX_NETWORK,
    nativeTokenCap: NATIVE_TOKEN_CAP,
  };
  const provenance: IndexProvenance = {
    kind: "thematic",
    // Thematic baskets have no single disclosed book; the person-book counters stay zero/null.
    bookSource: view.basis,
    fmpYear: null,
    annualFetchComplete: null,
    holdingsCount: 0,
    tickerHoldingsCount: 0,
    weightedTickerCount: view.constituents.length,
    unweightedTickerCount: 0,
    note: `Constructed multi-member research basket (${view.methodology}); not one person's disclosed book. Members: ${view.members.length}.`,
    basis: "insiderindex-thematic",
    lane: view.lane,
    methodology: view.methodology,
    memberCount: view.members.length,
    members: view.members.map((m) => ({
      slug: m.slug,
      name: m.name,
      party: m.party ?? null,
      state: m.state ?? null,
      bioguideId: m.bioguideId ?? null,
    })),
    constituentCount: view.constituents.length,
  };
  // The published research weights are the weight basis; catalog resolution/readiness is re-run so
  // a mint that is not in the live catalog becomes honestly unmapped (never a stale feed mint).
  const weighted = view.constituents.map((c) => ({ ticker: c.ticker, name: c.name, value: c.weight_bps }));
  return buildWeightedIndexDefinition({
    identity,
    weighted,
    weightBasis: "thematic-multi-member-value",
    provenance,
    activity: [],
    catalog,
    poolSource,
  });
}

export function deriveAllThematicIndexes(
  catalog: CatalogIndex,
  poolSource: PoolEvidenceSource,
): PersonIndexDefinition[] {
  return listThematicViews()
    .map((view) => deriveThematicIndex(view, catalog, poolSource))
    .sort((a, b) => a.indexId.localeCompare(b.indexId));
}
