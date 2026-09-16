import type { PersonIndex } from "../disclosures/types.ts";
import feed from "./thematic-indexes.live.json" with { type: "json" };
import { THEMATIC_INDEX_PREFIX, isThematicIndex, listThematicIndexes, getThematicIndex } from "../fomo/thematic-indexes.ts";

export { THEMATIC_INDEX_PREFIX, isThematicIndex, listThematicIndexes, getThematicIndex };

export type ThematicConstituentLive = {
  ticker: string;
  venue: "xstock" | "backpack";
  venueSymbol: string;
  mint: string;
  mintDecimals: number;
  weightPct: number;
  weightBps: number;
  valueUsd: number;
  displayName: string;
  filerCount?: number | null;
};

export type ThematicWebsiteCard = {
  id: string;
  slug: string;
  name: string;
  headline: string;
  tagline: string;
  narrative: string;
  hook: string;
  lane: string;
  rule: string;
  rebalance: string;
  whyItExists: string;
  members: { slug: string; name: string; party?: string | null; state?: string | null; bioguideId?: string }[];
  constituents: ThematicConstituentLive[];
  sourceLine: string;
  badge: string;
  apiPath: string;
};

export type ThematicIndexView = {
  id: string;
  slug: string;
  indexName: string;
  headline: string;
  tagline: string;
  narrative: string;
  hook: string;
  lane: string;
  rule: string;
  rebalance: string;
  whyItExists: string;
  basis: "insiderindex-thematic";
  methodology: string;
  status: "RESEARCH_MODEL";
  generatedAt: string;
  members: ThematicWebsiteCard["members"];
  constituents: {
    ticker: string;
    name: string;
    mint: string;
    issuer: "xstock" | "backpack";
    venueSymbol: string;
    mintDecimals: number;
    weight_bps: number;
    weightPct: number;
    filerCount: number | null;
  }[];
  personIndex: PersonIndex;
  sourceLine: string;
  sources: typeof feed.sources;
  disclaimers: string[];
  badge: string;
};

type Feed = {
  schemaVersion: number;
  generatedAt: string;
  sources: ThematicIndexView["sources"];
  disclaimers: string[];
  website: ThematicWebsiteCard[];
};

const LIVE = feed as Feed;

function methodologyFor(lane: string): string {
  if (lane.includes("hybrid")) return "holdings-and-trades-intersection";
  if (lane.includes("trades")) return "ptr-trade-activity";
  return "holding-band-midpoints-multi-member";
}

export function listThematicViews(): ThematicIndexView[] {
  const byId = new Map(listThematicIndexes().map((index) => [index.id, index]));
  return LIVE.website.flatMap((card) => {
    const personIndex = byId.get(card.id);
    if (!personIndex) return [];
    const constituents = card.constituents.map((c) => ({
      ticker: c.ticker,
      name: c.displayName,
      mint: c.mint,
      issuer: c.venue,
      venueSymbol: c.venueSymbol,
      mintDecimals: c.mintDecimals,
      weight_bps: c.weightBps,
      weightPct: c.weightPct,
      filerCount: c.filerCount ?? null,
    }));
    const total = constituents.reduce((sum, row) => sum + row.weight_bps, 0);
    if (total !== 10_000) return [];
    return [{
      id: card.id,
      slug: card.slug,
      indexName: card.name,
      headline: card.headline,
      tagline: card.tagline,
      narrative: card.narrative,
      hook: card.hook,
      lane: card.lane,
      rule: card.rule,
      rebalance: card.rebalance,
      whyItExists: card.whyItExists,
      basis: "insiderindex-thematic",
      methodology: methodologyFor(card.lane),
      status: "RESEARCH_MODEL",
      generatedAt: LIVE.generatedAt,
      members: card.members,
      constituents,
      personIndex,
      sourceLine: card.sourceLine,
      sources: LIVE.sources,
      disclaimers: LIVE.disclaimers,
      badge: card.badge,
    }];
  });
}

export function getThematicView(id: string): ThematicIndexView | null {
  const normalized = id.startsWith(THEMATIC_INDEX_PREFIX) ? id : `${THEMATIC_INDEX_PREFIX}${id.replace(/^theme-/, "")}`;
  return listThematicViews().find((view) => view.id === normalized || view.slug === id || view.id === id) ?? null;
}

export function thematicDirectory() {
  return {
    schemaVersion: LIVE.schemaVersion,
    generatedAt: LIVE.generatedAt,
    count: listThematicViews().length,
    status: "RESEARCH_MODEL" as const,
    sources: LIVE.sources,
    disclaimers: LIVE.disclaimers,
    indexes: listThematicViews().map((view) => ({
      id: view.id,
      slug: view.slug,
      name: view.indexName,
      headline: view.headline,
      tagline: view.tagline,
      hook: view.hook,
      lane: view.lane,
      legs: view.constituents.length,
      members: view.members.length,
      top5: view.constituents.slice(0, 5).map((c) => ({ ticker: c.ticker, weightBps: c.weight_bps })),
      href: `/indexes/${view.id}`,
      badge: view.badge,
    })),
  };
}
