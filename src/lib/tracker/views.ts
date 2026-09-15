import { baseIndexName } from "../fmp/index-name.ts";
import { mainnetRaydiumPoolSnapshot, poolReadiness, type MainnetRaydiumPool, type PoolReadiness } from "../index-vaults/raydium-pools-mainnet.ts";
import { VAULT_RELEASE } from "../index-vaults/release.ts";
import { preferredToken, type CatalogIndex, type CatalogToken } from "../venues/catalog-parse.ts";
import { loadSolanaCatalog, type CatalogFeedStatus } from "../venues/solana-catalog.ts";
import { trackerHandoff, trackerProfile, trackerSummaries } from "./handoff.ts";
import { buildTrackerIndex, type TrackerIndexDefinition } from "./tracker-index.ts";
import type { TrackerHandoff, TrackerProfile, TrackerSummary } from "./tracker-parse.ts";

/** Index-name input from the tracker identity when no saved FMP name exists; generational suffixes are not surnames. */
export function trackerIndexPerson(profile: TrackerProfile) {
  const words = profile.name.replace(/,/g, " ").split(/\s+/).filter((word) => word && !/^(jr|sr|ii|iii|iv)\.?$/i.test(word));
  return { id: profile.id, name: words.join(" "), firstName: words[0] ?? null, lastName: words.length > 1 ? words.at(-1)! : null };
}

export type TrackerHoldingToken = { ticker: string; token: CatalogToken | null; pool: PoolReadiness };
export type TrackerPersonView = {
  profile: TrackerProfile;
  index: TrackerIndexDefinition;
  holdingTokens: TrackerHoldingToken[];
  pools: MainnetRaydiumPool[];
  poolSnapshot: { fetchedAt: string; source: string };
  catalog: CatalogFeedStatus[];
  release: typeof VAULT_RELEASE;
};

export type TrackerDirectoryView = Pick<TrackerHandoff, "source" | "sourceLabel" | "asOf" | "scrapedAt" | "selection" | "count" | "partyMix" | "issues"> & {
  people: (TrackerSummary & { index: Pick<TrackerIndexDefinition, "id" | "indexName" | "readiness"> & { constituents: number } })[];
  poolSnapshot: { fetchedAt: string; source: string };
  catalog: CatalogFeedStatus[];
  release: typeof VAULT_RELEASE;
};

function poolMeta() {
  const snapshot = mainnetRaydiumPoolSnapshot();
  return { pools: snapshot.pools, poolSnapshot: { fetchedAt: snapshot.fetchedAt, source: snapshot.source } };
}

/** The canonical FMP index name (`index-name.ts`, collision-safe over the saved directory) wins; the tracker identity is the fallback. */
export function buildTrackerPersonView(profile: TrackerProfile, catalog: CatalogIndex & { feeds: CatalogFeedStatus[] }, savedIndexName?: string | null): TrackerPersonView {
  const { pools, poolSnapshot } = poolMeta();
  const index = buildTrackerIndex(profile, savedIndexName ?? baseIndexName(trackerIndexPerson(profile)), catalog, pools);
  const holdingTokens = profile.topHoldings.map((holding) => {
    const token = preferredToken(catalog, holding.ticker);
    return { ticker: holding.ticker, token, pool: token ? poolReadiness(token.mint, pools) : { status: "none" as const, pool: null, reason: "no-solana-mint" } };
  });
  return { profile, index, holdingTokens, pools, poolSnapshot, catalog: catalog.feeds, release: VAULT_RELEASE };
}

export async function trackerPersonView(id: string, savedIndexName?: string | null): Promise<TrackerPersonView | null> {
  const profile = trackerProfile(id);
  if (!profile) return null;
  return buildTrackerPersonView(profile, await loadSolanaCatalog(), savedIndexName);
}

export async function trackerDirectoryView(savedIndexNames?: ReadonlyMap<string, string> | null): Promise<TrackerDirectoryView> {
  const handoff = trackerHandoff();
  const catalog = await loadSolanaCatalog();
  const { pools, poolSnapshot } = poolMeta();
  const summaries = trackerSummaries();
  return {
    source: handoff.source, sourceLabel: handoff.sourceLabel, asOf: handoff.asOf, scrapedAt: handoff.scrapedAt, selection: handoff.selection,
    count: handoff.count, partyMix: handoff.partyMix, issues: handoff.issues,
    people: handoff.profiles.map((profile, i) => {
      const index = buildTrackerIndex(profile, savedIndexNames?.get(profile.id) ?? baseIndexName(trackerIndexPerson(profile)), catalog, pools);
      return { ...summaries[i], index: { id: index.id, indexName: index.indexName, readiness: index.readiness, constituents: index.constituents.length } };
    }),
    poolSnapshot, catalog: catalog.feeds, release: VAULT_RELEASE,
  };
}
