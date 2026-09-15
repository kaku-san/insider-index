import type { SupabaseClient } from "@supabase/supabase-js";
import { PeopleError, type PeopleService } from "./service.ts";
import { personId } from "./fmp-parse.ts";
import type { Person } from "./types.ts";
import type { PublishedHoldingsIndex } from "./holdings-index.ts";
import { indexNames } from "./index-name.ts";

export type StoredPortfolio = Awaited<ReturnType<PeopleService["portfolio"]>>;
export type StoredPerson = Person & { bookState: string; publishedIndexHash: string | null; indexName?: string };
type Directory = Omit<Awaited<ReturnType<PeopleService["directory"]>>, "people"> & { people: StoredPerson[]; storage: "supabase"; savedAt: string | null };

/** Exhaust REST pages rather than silently accepting Supabase's row cap. */
export async function readRows<T>(load: (from: number, to: number) => PromiseLike<{ data: unknown[] | null; error: unknown }>): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += 200) {
    const result = await load(from, from + 199);
    if (result.error || !result.data) throw new PeopleError(502, "saved-data-unavailable");
    rows.push(...result.data as T[]);
    if (result.data.length < 200) return rows;
  }
}
export function createStoredPeopleService(db: SupabaseClient) {
  async function savedIndexNames() {
    const rows = await readRows<{ payload: Person }>((from, to) => db.from("people").select("payload").order("id").range(from, to));
    return indexNames(rows.map((row) => row.payload));
  }
  async function publishedIndex(hash: string, names?: Map<string, string>): Promise<PublishedHoldingsIndex | null> {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new PeopleError(400, "invalid-index-id");
    const { data, error } = await db.from("index_versions").select("hash,person_id,period,version,status,published_at,definition,constituents(*)").eq("hash", hash).eq("status", "CANDIDATE").eq("definition->>basis", "disclosed-holdings").maybeSingle();
    if (error) throw new PeopleError(502, "saved-data-unavailable");
    if (!data) return null;
    const index = data as PublishedHoldingsIndex;
    // A staged/failed publication must never masquerade as a live target.
    if (!index.constituents.length || index.constituents.reduce((sum, c) => sum + c.weight_bps, 0) !== 10_000) throw new PeopleError(502, "incomplete-index-publication");
    index.constituents.sort((a, b) => b.weight_bps - a.weight_bps || a.ticker.localeCompare(b.ticker));
    const indexName = (names ?? await savedIndexNames()).get(index.person_id);
    if (!indexName) throw new PeopleError(502, "saved-data-unavailable");
    return { ...index, indexName };
  }
  async function latestHashes() {
    const rows = await readRows<{ hash: string; person_id: string }>((from, to) => db.from("index_versions").select("hash,person_id").eq("status", "CANDIDATE").eq("definition->>basis", "disclosed-holdings").order("version", { ascending: false }).order("hash").range(from, to));
    const hashes = new Map<string, string>();
    for (const row of rows) if (!hashes.has(row.person_id)) hashes.set(row.person_id, row.hash);
    return hashes;
  }
  return {
    publishedIndex,
    async directory(): Promise<Directory> {
      const [rows, meta, hashes] = await Promise.all([
        readRows<{ payload: Person; book_state: string }>((from, to) => db.from("people").select("payload,book_state").order("id").range(from, to)),
        db.from("fmp_store_state").select("payload,saved_at").eq("id", "directory").maybeSingle(),
        latestHashes(),
      ]);
      if (meta.error) throw new PeopleError(502, "saved-data-unavailable");
      const saved = meta.data?.payload as Omit<Directory, "people"> | undefined;
      const complete = saved?.complete === true && saved.ingestion.count === rows.length;
      const names = indexNames(rows.map((row) => row.payload));
      return {
        source: "fmp", storage: "supabase", savedAt: meta.data?.saved_at ?? null,
        complete, partial: !complete, unnormalizedCount: saved?.unnormalizedCount ?? 0,
        ingestion: saved?.ingestion ?? { status: "partial", complete: false, partial: true, count: rows.length, pages: [], issues: [] },
        coverage: "Saved FMP directory; book and activity coverage are reported separately for each person.",
        people: rows.map(({ payload, book_state }) => ({ ...payload, bookState: book_state, publishedIndexHash: hashes.get(payload.id) ?? null, indexName: names.get(payload.id)! })).sort((a, b) => a.name.localeCompare(b.name)),
      };
    },
    async portfolio(id: string) {
      if (!personId(id)) throw new PeopleError(400, "invalid-person-id");
      const { data, error } = await db.from("people").select("payload,portfolio,saved_at,book_state").eq("id", id).maybeSingle();
      if (error) throw new PeopleError(502, "saved-data-unavailable");
      if (!data) throw new PeopleError(404, "person-not-found");
      const { data: latest, error: indexError } = await db.from("index_versions").select("hash").eq("person_id", id).eq("status", "CANDIDATE").eq("definition->>basis", "disclosed-holdings").order("version", { ascending: false }).order("hash").limit(1).maybeSingle();
      if (indexError) throw new PeopleError(502, "saved-data-unavailable");
      const names = await savedIndexNames();
      const indexName = names.get(id);
      if (!indexName) throw new PeopleError(502, "saved-data-unavailable");
      const index = latest ? await publishedIndex(latest.hash, names) : null;
      return {
        ...(data.portfolio as StoredPortfolio | null),
        person: data.payload as Person, source: "fmp" as const, storage: "supabase" as const,
        savedAt: data.saved_at as string | null,
        state: data.portfolio?.state ?? "not-ingested",
        complete: data.portfolio?.complete ?? false, partial: data.portfolio?.partial ?? true,
        snapshots: (data.portfolio?.snapshots ?? []) as StoredPortfolio["snapshots"],
        activity: (data.portfolio?.activity ?? []) as StoredPortfolio["activity"],
        publishedIndex: index, indexName,
      };
    },
    async topProfiles() {
      const { data, error } = await db.rpc("read_top_politician_profiles");
      if (error || !data || typeof data !== "object" || Array.isArray(data)) throw new PeopleError(502, "saved-data-unavailable");
      return data;
    },
  };
}
export type StoredPeopleService = ReturnType<typeof createStoredPeopleService>;
