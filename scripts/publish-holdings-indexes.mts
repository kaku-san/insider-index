/** Holdings determine membership and weights. Saved trades may resolve a name, never supply a balance. */
import { createClient } from "@supabase/supabase-js";
import { createFmpClient } from "../src/lib/fmp/client.ts";
import { supabaseArchive } from "../src/lib/fmp/ingest.ts";
import { readRows } from "../src/lib/fmp/store.ts";
import { buildHoldingsIndex, type SavedSnapshot } from "../src/lib/fmp/holdings-index.ts";
import { holdingSearchText, resolveHolding } from "../src/lib/fmp/holding-resolution.ts";
import { publishHoldingsIndex } from "../src/lib/fmp/publish.ts";
import { loadSolanaCatalog } from "../src/lib/venues/solana-catalog.ts";
import type { Activity, Batch } from "../src/lib/fmp/types.ts";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error("Supabase service configuration required");
const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
const publish = process.argv.includes("--publish");
const client = createFmpClient({ archive: supabaseArchive(db) });
const catalog = await loadSolanaCatalog();
// Read metadata first: downloading every historical book can exceed REST statement budgets.
const snapshots = await readRows<{ id: string; person_id: string; period: string | null; filing_date: string | null }>((a, b) => db.from("book_snapshots").select("id,person_id,period,filing_date:payload->>filingDate").order("id").range(a, b));
// Reuse archived candidate searches across runs, retaining original evidence timestamps.
const captures = await readRows<{ endpoint: "search-name"; params: { query: string; limit: number }; fetched_at: string; payload_hash: string; row_count: number; body: string }>((a, b) => db.from("raw_batches").select("endpoint,params,fetched_at,payload_hash,row_count,body").eq("endpoint", "search-name").eq("http_status", 200).order("fetched_at").order("id").range(a, b));
const searches = new Map<string, Promise<Batch>>();
for (const capture of captures) {
  const rows = JSON.parse(capture.body);
  if (!Array.isArray(rows)) continue;
  const source = { endpoint: capture.endpoint, params: capture.params, fetchedAt: new Date(capture.fetched_at).toISOString(), payloadHash: capture.payload_hash, rowCount: capture.row_count };
  const complete = rows.length < capture.params.limit;
  searches.set(capture.params.query, Promise.resolve({ endpoint: "search-name", status: complete ? "complete" : "partial", complete, rows: rows.map((row, ordinal) => ({ row, ordinal, source })), pages: [source], issues: [] }));
}
const only = process.argv.find((a) => a.startsWith("--person="))?.split("=")[1];
let published = 0;
const pending = [...new Set(snapshots.map((s) => s.person_id))].filter((id) => !only || id === only)
  .sort((a, b) => Number(b === "P000197") - Number(a === "P000197") || a.localeCompare(b));
await Promise.all(Array.from({ length: 3 }, async () => {
for (let id; (id = pending.shift());) {
  const latest = snapshots.filter((s) => s.person_id === id && s.period).sort((a, b) => b.period!.localeCompare(a.period!) || (b.filing_date ?? "").localeCompare(a.filing_date ?? "") || a.id.localeCompare(b.id))[0];
  if (!latest) continue;
  const { data, error } = await db.from("book_snapshots").select("id,payload").eq("id", latest.id).single();
  if (error || !data) throw new Error("saved-snapshot-unavailable");
  const snapshot = data as SavedSnapshot;
  const activity = (await readRows<{ payload: Activity }>((a, b) => db.from("transactions").select("payload").eq("person_id", id).order("id").range(a, b))).map((t) => t.payload);
  const resolutions = [];
  for (const holding of snapshot.payload.items) {
    let resolution = resolveHolding(holding, activity, null, catalog);
    const query = holdingSearchText(holding.name);
    if (resolution.reason === "unresolved-security" && query) {
      if (!searches.has(query)) searches.set(query, client.searchNames(query));
      resolution = resolveHolding(holding, activity, await searches.get(query)!, catalog);
    }
    resolutions.push(resolution);
  }
  const definition = buildHoldingsIndex(snapshot, resolutions);
  if (!definition) { console.log(JSON.stringify({ id, state: "no-mapped-holdings", rows: resolutions.length })); continue; }
  const hash = publish ? await publishHoldingsIndex(db, definition) : "dry-run";
  console.log(JSON.stringify({ id, hash, period: definition.period, snapshotComplete: definition.snapshotComplete, constituents: definition.constituents.length, excluded: definition.excluded.length }));
  published++;
}
}));
console.log(JSON.stringify({ mode: publish ? "published" : "dry-run", published }));
