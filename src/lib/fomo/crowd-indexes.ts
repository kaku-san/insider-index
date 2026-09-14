// Crowd indexes: one basket built from many filers' buys on tradable names.
// Weight = share of distinct filers who bought that name in the window.
// These reuse the PersonIndex shape so /api/indexes/[id] and /api/indexes/quote
// work unchanged; `profileId` is a synthetic group id and has no profile page.
import type { ActorKind, Disclosure, IndexConstituent, PersonIndex } from "@/lib/disclosures/types";
import { CROWD_INDEX_PREFIX, isCountableBuy } from "@/lib/fomo/index-readiness";

const CROWD_GROUPS: { slug: string; name: string; kind: ActorKind }[] = [
  { slug: "congress", name: "Capitol Buys Index", kind: "politician" },
  { slug: "insiders", name: "Insider Buys Index", kind: "insider" },
];

export function crowdIndexId(slug: string): string {
  return `${CROWD_INDEX_PREFIX}${slug}`;
}

function reportedValue(row: Disclosure): number {
  if (row.transactionValue != null) return row.transactionValue;
  if (row.amountLow != null || row.amountHigh != null) {
    return ((row.amountLow ?? row.amountHigh ?? 0) + (row.amountHigh ?? row.amountLow ?? 0)) / 2;
  }
  return 0;
}

export function buildCrowdIndex(slug: string, name: string, kind: ActorKind, disclosures: Disclosure[], now = Date.now()): PersonIndex {
  const rows = disclosures.filter((row) => row.kind === kind && isCountableBuy(row, now));
  type Bucket = Omit<IndexConstituent, "weightPct"> & { filers: Set<string> };
  const byTicker = new Map<string, Bucket>();
  for (const row of rows) {
    if (row.venue === "none" || !row.venueSymbol || !row.mint || row.mintDecimals == null) continue;
    const ticker = row.ticker.toUpperCase();
    const bucket = byTicker.get(ticker) ?? {
      ticker,
      venue: row.venue,
      venueSymbol: row.venueSymbol,
      mint: row.mint,
      mintDecimals: row.mintDecimals,
      filers: new Set<string>(),
      valueUsd: 0,
    };
    bucket.filers.add(row.profileId);
    bucket.valueUsd += reportedValue(row);
    byTicker.set(ticker, bucket);
  }
  const totalFilerVotes = [...byTicker.values()].reduce((sum, b) => sum + b.filers.size, 0) || 1;
  const constituents: IndexConstituent[] = [...byTicker.values()]
    .sort((a, b) => b.filers.size - a.filers.size || b.valueUsd - a.valueUsd)
    .map(({ filers, ...b }) => ({ ...b, weightPct: filers.size / totalFilerVotes }));
  const latest = [...rows].sort((a, b) => +new Date(b.filedAt) - +new Date(a.filedAt))[0];
  return {
    id: crowdIndexId(slug),
    profileId: `crowd-${slug}`,
    name,
    imageUrl: null,
    kind,
    party: null,
    constituents,
    lastDisclosureId: latest?.id ?? null,
    lastDisclosureAt: latest?.filedAt ?? null,
  };
}

/** Crowd indexes with at least one tradable buy. Readiness is judged separately. */
export function buildCrowdIndexes(disclosures: Disclosure[], now = Date.now()): PersonIndex[] {
  return CROWD_GROUPS.map((group) => buildCrowdIndex(group.slug, group.name, group.kind, disclosures, now)).filter((index) => index.constituents.length > 0);
}
