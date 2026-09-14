/** Operator-only: fill missing annual snapshots, Pelosi first; never fetch trades. */
import { createClient } from "@supabase/supabase-js";
import { createFmpClient } from "../src/lib/fmp/client.ts";
import { createPeopleService } from "../src/lib/fmp/service.ts";
import { readRows, type StoredPortfolio } from "../src/lib/fmp/store.ts";
import { saveHoldings, supabaseArchive } from "../src/lib/fmp/ingest.ts";
import { loadSolanaCatalog } from "../src/lib/venues/solana-catalog.ts";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error("Supabase service configuration required");
const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
const client = createFmpClient({ archive: supabaseArchive(db) });
const service = createPeopleService(client, loadSolanaCatalog);
const rows = await readRows<{ id: string }>((a, b) => db.from("people").select("id").order("id").range(a, b));
const savedSnapshots = await readRows<{ person_id: string }>((a, b) => db.from("book_snapshots").select("person_id").order("id").range(a, b));
const hasSnapshot = new Set(savedSnapshots.map((s) => s.person_id));
if (!rows.some((p) => p.id === "P000197")) rows.push({ id: "P000197" });
const only = process.argv.find((a) => a.startsWith("--person="))?.split("=")[1];
const pending = rows.filter((p) => only ? p.id === only : !hasSnapshot.has(p.id))
  .sort((a, b) => Number(b.id === "P000197") - Number(a.id === "P000197") || a.id.localeCompare(b.id));
console.log(JSON.stringify({ mode: process.argv.includes("--save") ? "save" : "dry-run", missing: pending.length }));
if (process.argv.includes("--save")) {
  let failed = 0;
  // Bounded concurrency; transport handles provider retry budgets and repeated pages.
  await Promise.all(Array.from({ length: 3 }, async () => {
    for (let row; (row = pending.shift());) {
      try {
        const { data, error } = await db.from("people").select("portfolio").eq("id", row.id).maybeSingle();
        if (error) throw new Error("saved-portfolio-unavailable");
        const portfolio = await service.portfolio(row.id, { holdingsOnly: true });
        await saveHoldings(db, portfolio, data?.portfolio as StoredPortfolio | null);
        console.log(JSON.stringify({ id: row.id, snapshots: portfolio.snapshots.length, rows: portfolio.snapshots.reduce((n, s) => n + s.items.length, 0), annual: portfolio.ingestion.annual.status }));
        if (portfolio.ingestion.annual.status === "failed") failed++;
      } catch {
        failed++;
        console.log(JSON.stringify({ id: row.id, error: "holdings-ingestion-failed" }));
      }
    }
  }));
  console.log(JSON.stringify({ failed }));
  if (failed) process.exitCode = 1;
}
