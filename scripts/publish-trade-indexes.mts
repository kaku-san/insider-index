/** Operator-only publication of saved FMP trade activity. No upstream FMP fetch or book writes. */
import { createClient } from "@supabase/supabase-js";
import { loadSolanaCatalog } from "../src/lib/venues/solana-catalog.ts";
import { readRows } from "../src/lib/fmp/store.ts";
import { buildTradeIndex } from "../src/lib/fmp/trade-index.ts";
import { publishTradeIndex } from "../src/lib/fmp/publish.ts";
import type { Activity } from "../src/lib/fmp/types.ts";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error("Supabase service configuration required");
const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
const commit = process.argv.includes("--publish");
const catalog = await loadSolanaCatalog();
const rows = await readRows<{ person_id: string; payload: Activity }>((from, to) => db.from("transactions").select("person_id,payload").order("id").range(from, to));
const people = new Map<string, Activity[]>();
for (const row of rows) people.set(row.person_id, [...(people.get(row.person_id) ?? []), row.payload]);
let published = 0;
let constituents = 0;
for (const [id, trades] of people) {
  const definition = buildTradeIndex(id, trades, catalog);
  if (!definition) continue;
  const hash = commit ? await publishTradeIndex(db, definition) : "dry-run";
  console.log(`${id} ${hash} ${definition.constituents.length} constituents ${definition.methodology}`);
  published++;
  constituents += definition.constituents.length;
}
console.log(JSON.stringify({ mode: commit ? "published" : "dry-run", people: published, constituents, catalog: catalog.feeds.map(({ issuer, source }) => ({ issuer, source })) }));
