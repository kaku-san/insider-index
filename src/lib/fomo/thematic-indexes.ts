/**
 * Curated multi-member thematic indexes (Mag7 Caucus, Silicon Hill, …).
 * Snapshot model weights — not person clones (those live on /p/[id]).
 * Shape matches PersonIndex so /api/indexes and IndexTicket work unchanged.
 */
import type { IndexConstituent, PersonIndex } from "../disclosures/types.ts";
import feed from "../thematic/thematic-indexes.live.json" with { type: "json" };

export const THEMATIC_INDEX_PREFIX = "idx-theme-";

type LiveConstituent = {
  ticker: string;
  venue: "xstock" | "backpack";
  venueSymbol: string;
  mint: string;
  mintDecimals: number;
  weightPct: number;
  valueUsd: number;
};

type LiveIndex = {
  id: string;
  profileId: string;
  name: string;
  imageUrl: string | null;
  kind: "politician";
  party: null;
  constituents: LiveConstituent[];
  lastDisclosureId: string | null;
  lastDisclosureAt: string | null;
};

type LiveFeed = {
  schemaVersion: number;
  generatedAt: string;
  indexes: LiveIndex[];
};

const LIVE = feed as LiveFeed;

export function isThematicIndex(index: Pick<PersonIndex, "id">): boolean {
  return index.id.startsWith(THEMATIC_INDEX_PREFIX);
}

function toPersonIndex(row: LiveIndex): PersonIndex {
  const constituents: IndexConstituent[] = row.constituents.map((c) => ({
    ticker: c.ticker,
    venue: c.venue,
    venueSymbol: c.venueSymbol,
    mint: c.mint,
    mintDecimals: c.mintDecimals,
    weightPct: c.weightPct,
    valueUsd: c.valueUsd,
  }));
  return {
    id: row.id,
    profileId: row.profileId,
    name: row.name,
    imageUrl: row.imageUrl,
    kind: "politician",
    party: null,
    constituents,
    lastDisclosureId: row.lastDisclosureId,
    lastDisclosureAt: row.lastDisclosureAt,
  };
}

/** Static thematic baskets ready for /api/indexes. */
export function listThematicIndexes(): PersonIndex[] {
  return LIVE.indexes
    .map(toPersonIndex)
    .filter((index) => index.constituents.length > 0);
}

export function getThematicIndex(id: string): PersonIndex | null {
  return listThematicIndexes().find((index) => index.id === id || index.profileId === id) ?? null;
}

export function thematicFeedMeta(): { schemaVersion: number; generatedAt: string; count: number } {
  return {
    schemaVersion: LIVE.schemaVersion,
    generatedAt: LIVE.generatedAt,
    count: LIVE.indexes.length,
  };
}
