import { listCongressTape } from "@/lib/disclosures/congress";
import { listInsiderTape } from "@/lib/disclosures/form4";
import type {
  CopySignal,
  Disclosure,
  FomoProfile,
  LaneStatus,
  PersonIndex,
  PoliticalParty,
} from "@/lib/disclosures/types";
import { buildCrowdIndexes } from "@/lib/fomo/crowd-indexes";
import { buildProfile, signalFomo, signalHeadline } from "@/lib/fomo/insights";
import { portraitFor } from "@/lib/fomo/portraits";
import { getThematicIndex, listThematicIndexes } from "@/lib/fomo/thematic-indexes";
import { fetchMintPrices } from "@/lib/venues/prices";
import { loadVenueCatalog, tagVenues } from "@/lib/venues/resolve";

const FOLLOWERS: Record<string, number> = {
  "insider-0001199036": 18420,
  "insider-0001214156": 15210,
  "insider-0001494730": 7340,
  "insider-0001623824": 12110,
  "insider-0001548760": 16880,
  "insider-0001537655": 9904,
  "insider-0001635575": 11240,
  "insider-0001533756": 6402,
  "insider-0001463207": 8810,
  "insider-0001037443": 14002,
  "pol-nancy-pelosi": 48210,
  "pol-ro-khanna": 12940,
  "pol-josh-gottheimer": 7055,
  "pol-debbie-wasserman-schultz": 5120,
  "pol-marjorie-taylor-greene": 22140,
  "pol-dan-crenshaw": 15880,
  "pol-michael-mccaul": 6340,
  "pol-austin-scott": 2980,
};

export type DisclosureTape = {
  disclosures: Disclosure[];
  lanes: { insiders: LaneStatus; congress: LaneStatus };
};

/**
 * Both lanes with provenance, every row tagged with the Solana mint it can be
 * copied into (xStock, Backpack, or none). Rows without a ticker never reach
 * the tape; rows without a mint stay on it — they are still the book.
 */
export async function listDisclosureTape(): Promise<DisclosureTape> {
  const [insiders, congress, catalog] = await Promise.all([
    listInsiderTape({ perPage: 5000 }),
    listCongressTape(),
    loadVenueCatalog(),
  ]);
  const disclosures = tagVenues(
    [...insiders.rows, ...congress.rows].filter((row) => Boolean(row.ticker?.trim())),
    catalog,
  ).sort((a, b) => +new Date(b.filedAt) - +new Date(a.filedAt));
  return { disclosures, lanes: { insiders: insiders.status, congress: congress.status } };
}

/** One disclosure by id, venue-tagged like the tape. */
export async function getDisclosure(id: string): Promise<Disclosure | null> {
  const { getDisclosureById } = await import("@/lib/disclosures/form4");
  const [row, catalog] = await Promise.all([getDisclosureById(id), loadVenueCatalog()]);
  return row ? tagVenues([row], catalog)[0] : null;
}

export async function listAllDisclosures(): Promise<Disclosure[]> {
  return (await listDisclosureTape()).disclosures;
}

export async function listSignals(filters?: {
  kind?: Disclosure["kind"];
  party?: PoliticalParty;
  profileId?: string;
}): Promise<CopySignal[]> {
  const rows = await listAllDisclosures();
  return rows
    .filter((row) => (filters?.kind ? row.kind === filters.kind : true))
    .filter((row) => (filters?.party ? row.party === filters.party : true))
    .filter((row) => (filters?.profileId ? row.profileId === filters.profileId : true))
    .map((row) => ({
      ...row,
      headline: signalHeadline(row),
      fomoLabel: signalFomo(row),
      imageUrl: portraitFor(row.profileId),
    }));
}

/**
 * Insider prints normally carry their own price. When one does not, the
 * reported share count is valued at the mint's last on-chain price; names
 * without a mint (or a pool) stay unsized instead of being guessed.
 */
async function insiderFallbackPricer(trades: Disclosure[]): Promise<(ticker: string) => number | null> {
  const byTicker = new Map<string, string>();
  for (const trade of trades) {
    if (trade.kind === "insider" && trade.sharesOwnedAfter != null && trade.pricePerShare == null && trade.mint) {
      byTicker.set(trade.ticker.toUpperCase(), trade.mint);
    }
  }
  if (byTicker.size === 0) return () => null;
  const prices = await fetchMintPrices([...byTicker.values()]);
  return (ticker) => {
    const mint = byTicker.get(ticker.toUpperCase());
    return mint ? (prices[mint] ?? null) : null;
  };
}

export async function listProfiles(rows?: Disclosure[]): Promise<FomoProfile[]> {
  const trades = rows ?? (await listAllDisclosures());
  const grouped = new Map<string, Disclosure[]>();
  for (const trade of trades) {
    const bucket = grouped.get(trade.profileId) ?? [];
    bucket.push(trade);
    grouped.set(trade.profileId, bucket);
  }
  const priceFor = await insiderFallbackPricer(trades);

  const now = Date.now();
  return [...grouped.entries()]
    .map(([id, rows]) => {
      const head = rows[0];
      return buildProfile(id, rows, {
        kind: head.kind,
        name: head.insiderName,
        handle: id.replace(/^(insider|pol)-/, "@"),
        title: head.insiderTitle ?? (head.kind === "politician" ? "House" : "Insider"),
        party: head.party,
        chamber: head.chamber,
        state: head.state,
        cikOrBioguide: head.insiderCik,
        followers: FOLLOWERS[id] ?? 1200 + rows.length * 180,
      }, now, priceFor);
    })
    // Most recently active first, then the deepest book. No synthetic PnL ordering.
    .sort((a, b) => +new Date(b.lastSignalAt) - +new Date(a.lastSignalAt) || b.portfolio.length - a.portfolio.length);
}

export async function getProfile(id: string): Promise<FomoProfile | null> {
  const profiles = await listProfiles();
  return profiles.find((profile) => profile.id === id) ?? null;
}

export async function getProfileTrades(id: string): Promise<CopySignal[]> {
  return listSignals({ profileId: id });
}

export async function listIndexes(): Promise<PersonIndex[]> {
  const disclosures = await listAllDisclosures();
  const personIndexes = (await listProfiles(disclosures))
    .map((profile) => profile.index)
    .filter((index) => index.constituents.length > 0);
  // Thematic curated themes → crowd tape baskets → person books.
  return [...listThematicIndexes(), ...buildCrowdIndexes(disclosures), ...personIndexes];
}

export async function getIndex(id: string): Promise<PersonIndex | null> {
  const thematic = getThematicIndex(id);
  if (thematic) return thematic;
  const indexes = await listIndexes();
  return (
    indexes.find((index) => index.id === id || index.profileId === id) ?? null
  );
}

/** Kick off both lanes without awaiting (server warm-up). */
export function warmDisclosureTape(): void {
  void listDisclosureTape().catch(() => undefined);
}
