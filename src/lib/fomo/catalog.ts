import { listCongressDisclosures } from "@/lib/disclosures/congress";
import { listAllowlistedDisclosures } from "@/lib/disclosures/form4";
import type {
  CopySignal,
  Disclosure,
  FomoProfile,
  PersonIndex,
  PoliticalParty,
} from "@/lib/disclosures/types";
import { buildCrowdIndexes } from "@/lib/fomo/crowd-indexes";
import { buildProfile, signalFomo, signalHeadline } from "@/lib/fomo/insights";
import { portraitFor } from "@/lib/fomo/portraits";

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

export async function listAllDisclosures(): Promise<Disclosure[]> {
  const [form4, congress] = await Promise.all([
    listAllowlistedDisclosures({ perPage: 100 }),
    listCongressDisclosures(),
  ]);
  return [...form4, ...congress]
    .filter((row) => Boolean(row.ticker?.trim()))
    .sort((a, b) => +new Date(b.filedAt) - +new Date(a.filedAt));
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

export async function listProfiles(rows?: Disclosure[]): Promise<FomoProfile[]> {
  const trades = rows ?? (await listAllDisclosures());
  const grouped = new Map<string, Disclosure[]>();
  for (const trade of trades) {
    const bucket = grouped.get(trade.profileId) ?? [];
    bucket.push(trade);
    grouped.set(trade.profileId, bucket);
  }

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
      });
    })
    .sort((a, b) => b.copiedPnl90d - a.copiedPnl90d);
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
  // Crowd baskets (many filers, one basket) lead; person baskets follow.
  return [...buildCrowdIndexes(disclosures), ...personIndexes];
}

export async function getIndex(id: string): Promise<PersonIndex | null> {
  const indexes = await listIndexes();
  return (
    indexes.find((index) => index.id === id || index.profileId === id) ?? null
  );
}
