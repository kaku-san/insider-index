/** Rank saved FMP books into a durable top-20. No FMP/AInvest network. Dry-run unless --publish. */
import { createClient } from "@supabase/supabase-js";
import { publishTopProfiles } from "../src/lib/fmp/publish.ts";
import { readRows } from "../src/lib/fmp/store.ts";
import type { SavedSnapshot } from "../src/lib/fmp/holdings-index.ts";
import { rankPoliticianProfiles, type PublishedWeightsInput, type RankablePerson } from "../src/lib/fmp/top-profiles.ts";
import type { Person } from "../src/lib/fmp/types.ts";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error("Supabase service configuration required");
const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
const publish = process.argv.includes("--publish");

const people = await readRows<{ payload: Person; book_state: string }>((a, b) =>
  db.from("people").select("payload,book_state").order("id").range(a, b));
const snapshotMeta = await readRows<{ id: string; person_id: string; period: string | null; filing_date: string | null }>((a, b) =>
  db.from("book_snapshots").select("id,person_id,period,filing_date:payload->>filingDate").order("id").range(a, b));
const latestId = new Map<string, string>();
for (const id of new Set(snapshotMeta.map((row) => row.person_id))) {
  const latest = snapshotMeta.filter((row) => row.person_id === id && row.period)
    .sort((a, b) => b.period!.localeCompare(a.period!) || (b.filing_date ?? "").localeCompare(a.filing_date ?? "") || a.id.localeCompare(b.id))[0];
  if (latest) latestId.set(id, latest.id);
}
const snapshots = new Map<string, SavedSnapshot>();
const ids = [...latestId.values()];
for (let i = 0; i < ids.length; i += 50) {
  const { data, error } = await db.from("book_snapshots").select("id,payload").in("id", ids.slice(i, i + 50));
  if (error || !data) throw new Error("saved-snapshot-unavailable");
  for (const row of data as SavedSnapshot[]) snapshots.set(row.id, row);
}
const indexRows = await readRows<PublishedWeightsInput & { person_id: string }>((a, b) =>
  db.from("index_versions").select("hash,person_id,period,definition,constituents(*)").eq("status", "CANDIDATE").eq("definition->>basis", "disclosed-holdings").order("version", { ascending: false }).order("hash").range(a, b));
const indexes = new Map<string, PublishedWeightsInput>();
for (const row of indexRows) if (!indexes.has(row.person_id)) indexes.set(row.person_id, row);

const input: RankablePerson[] = people.map(({ payload, book_state }) => ({
  person: payload,
  bookState: book_state,
  snapshot: snapshots.get(latestId.get(payload.id) ?? "") ?? null,
  publishedIndex: indexes.get(payload.id) ?? null,
}));
const document = rankPoliticianProfiles(input);
if (publish) await publishTopProfiles(db, document);
console.log(JSON.stringify({
  mode: publish ? "published" : "dry-run",
  listed: document.listed,
  universeSize: document.universeSize,
  pelosiPinned: document.pelosiPinned,
  profiles: document.profiles.map((p) => ({
    id: p.person.id, rank: p.rank, pinned: p.pinned, midpoint: p.estimatedValue.midpoint, holdings: p.holdings.length,
  })),
}));
