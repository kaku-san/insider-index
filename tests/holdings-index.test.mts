import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { createClient } from "@supabase/supabase-js";
import { publishHoldingsIndex } from "../src/lib/fmp/publish.ts";
import { createFmpClient } from "../src/lib/fmp/client.ts";
import { createPeopleService } from "../src/lib/fmp/service.ts";
import { annualSnapshots } from "../src/lib/fmp/fmp-parse.ts";
import { indexCatalog } from "../src/lib/venues/catalog-parse.ts";
import { resolveHolding, holdingName, holdingSearchText, matchesHoldingName } from "../src/lib/fmp/holding-resolution.ts";
import { buildHoldingsIndex, latestHoldingSnapshot } from "../src/lib/fmp/holdings-index.ts";
import { contentHash } from "../src/lib/fmp/trade-index.ts";
import type { Activity, Batch } from "../src/lib/fmp/types.ts";

const pid = "P000197";
const tokens = [
  { ticker: "AAPL", mint: "A".repeat(44), issuer: "xstock" as const, symbol: "AAPLx", name: "Apple", decimals: 8 },
  { ticker: "AAPL", mint: "B".repeat(44), issuer: "backpack" as const, symbol: "AAPL.US", name: "Apple", decimals: 6 },
  { ticker: "NVDA", mint: "C".repeat(44), issuer: "backpack" as const, symbol: "NVDA.US", name: "NVIDIA", decimals: 6 },
];
const catalog = indexCatalog(tokens);
function batch(endpoint: Batch["endpoint"], rows: Record<string, unknown>[], complete = true): Batch {
  const source = { endpoint, params: endpoint === "search-name" ? { query: "apple", limit: 100 } : { senateID: pid, page: 0, limit: 250 }, fetchedAt: "2026-09-14T00:00:00.000Z", payloadHash: contentHash(rows), rowCount: rows.length };
  return { endpoint, complete, status: complete ? "complete" : "partial", rows: rows.map((row, ordinal) => ({ row, ordinal, source })), pages: [source], issues: [] };
}
const annualRows = [
  { name: "Apple Inc. (AAPL) [ST]", valueRange: { min: 100, max: 200 } },
  { name: "NVIDIA Corporation - Common Stock (NVDA) [ST]", valueRange: { min: 300, max: 600 } },
  { name: "Unresolved Startup [ST]", valueRange: { min: null, max: null } },
  { name: "Apple (AAPL) [OP]", valueRange: { min: 1000, max: 2000 } },
].map((r) => ({ ...r, senateID: pid, year: 2024, filingDate: "2025-05-15", link: "https://example.test/report.pdf", section: "Asset", formType: "House Report" }));
const annual = batch("senate-net-worth", annualRows, false);
const payload = annualSnapshots(annual, pid)[0];
const snapshot = { id: contentHash(payload), payload };
const search = batch("search-name", [
  { symbol: "AAPL", name: "Apple Inc.", currency: "USD", exchange: "NASDAQ" },
  { symbol: "NVDA", name: "NVIDIA Corporation", currency: "USD", exchange: "NASDAQ" },
]);
const resolutions = payload.items.map((i) => resolveHolding(i, [], search, catalog));

test("latest annual holdings publish without any trades, including partial sources; all names survive", () => {
  const before = structuredClone(snapshot);
  const definition = buildHoldingsIndex(snapshot, resolutions)!;
  assert.equal(definition.basis, "disclosed-holdings");
  assert.equal(definition.snapshotComplete, false);
  assert.deepEqual(definition.constituents.map((c) => [c.ticker, c.issuer, c.weightBps]), [["AAPL", "xstock", 2500], ["NVDA", "backpack", 7500]]);
  assert.equal(definition.evidence.length, 4);
  assert.equal(definition.excluded.length, 2);
  assert.equal(definition.constituents[0].holdingIds.length, 1);
  assert.deepEqual(snapshot, before);
  const older = { id: "older", payload: { ...payload, referenceDate: "2023-12-31", complete: true } };
  assert.equal(latestHoldingSnapshot(pid, [older, snapshot])?.id, snapshot.id);
  assert.equal(latestHoldingSnapshot("X000001", [snapshot]), null);
});
test("holdings publication uses only its atomic RPC and canonicalizes derived documents across archive reads", async () => {
  const calls: string[] = [];
  const db = createClient("https://saved.example.test", "test-only", { global: { fetch: async (input, init) => {
    assert.equal(new URL(String(input)).pathname, "/rest/v1/rpc/publish_fmp_holdings_index");
    calls.push(String(init?.body)); return Response.json(null);
  } } });
  const definition = buildHoldingsIndex(snapshot, resolutions)!;
  const before = structuredClone(definition);
  const reordered = JSON.parse(JSON.stringify(definition, (_key, value) => value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.keys(value).reverse().map((key) => [key, value[key]])) : value));
  assert.equal(await publishHoldingsIndex(db, definition), await publishHoldingsIndex(db, reordered));
  assert.equal(calls[0], calls[1]);
  assert.deepEqual(definition, before);
});

test("search candidates require exact name, exchange and symbol corroboration; ambiguities are not buys", () => {
  const item = { ...payload.items[0], name: "Apple Inc [ST]" };
  assert.equal(resolveHolding(item, [], batch("search-name", [{ symbol: "AAPL", name: "Pineapple Inc", currency: "USD", exchange: "NASDAQ" }]), catalog).ticker, null);
  assert.equal(resolveHolding(item, [], { ...search, complete: false }, catalog).ticker, null);
  assert.equal(resolveHolding(item, [], batch("search-name", [search.rows[0].row, { ...search.rows[0].row, symbol: "OTHER" }]), catalog).reason, "ambiguous-search-symbols");
  assert.equal(resolveHolding(item, [], batch("search-name", [{ ...search.rows[0].row, exchange: "LSE" }]), catalog).ticker, null);
  assert.equal(matchesHoldingName("Alphabet Inc - Class A (GOOGL) [ST]", "Alphabet Inc.", "GOOG"), false);
  assert.equal(matchesHoldingName("Alphabet Inc - Class A (GOOGL) [ST]", "Alphabet Inc.", "GOOGL"), true);
  assert.equal(matchesHoldingName("Alphabet Inc - Class A [ST]", "Alphabet Inc.", "GOOGL"), false);
  assert.equal(holdingName("IRA ⇒ Apple Inc. (AAPL) [ST]"), "apple");
  assert.equal(holdingSearchText("Amazon.com, Inc. (AMZN) [ST]"), "amazon.com");
  const trade = { id: "later-trade", personId: pid, name: "Apple Inc", ticker: "AAPL", kind: "stock", amount: { low: 99999, high: 99999 } } as Activity;
  assert.equal(resolveHolding(item, [{ ...trade, personId: "X000001" }], null, catalog).ticker, null);
  const resolved = resolveHolding(item, [trade], null, catalog);
  assert.equal(resolved.method, "person-trade-symbol");
  assert.deepEqual(resolved.tradeIds, ["later-trade"]);
  assert.equal(resolved.holding.valueRange.low, 100);
});
test("unknown mapped holding values trigger labelled equal weights, not invented zero or trade sizes", () => {
  const book = structuredClone(snapshot);
  book.payload.items[0].valueRange = { low: 100, high: null };
  const definition = buildHoldingsIndex(book, book.payload.items.map((i) => resolveHolding(i, [], search, catalog)))!;
  assert.equal(definition.methodology, "equal-weight-mapped-holdings");
  assert.deepEqual(definition.constituents.map((c) => c.weightBps), [5000, 5000]);
  assert.equal(definition.evidence[0].holding.valueRange.high, null);
  assert.throws(() => buildHoldingsIndex(book, resolutions.slice(1)), /evidence-mismatch/);
});
test("holdings-only ingestion never calls aggregates or either chamber history", async () => {
  const paths: string[] = [];
  const client = createFmpClient({ key: async () => "unit-only-credential", archive: async () => {}, fetch: async (input) => {
    const url = new URL(String(input)); paths.push(url.pathname);
    if (url.searchParams.get("page") === "1") return Response.json([]);
    if (url.pathname.endsWith("senate-profile")) return Response.json([{ senateID: pid, firstName: "Nancy", lastName: "Pelosi", latestPosition: "Representative" }]);
    assert.ok(url.pathname.endsWith("senate-net-worth"));
    return Response.json(annualRows);
  } });
  const book = await createPeopleService(client, async () => catalog).portfolio(pid, { holdingsOnly: true });
  assert.equal(book.person.name, "Nancy Pelosi");
  assert.equal(book.snapshots[0].items.length, 4);
  assert.equal(book.activity.length, 0);
  assert.equal(book.ingestion.houseActivity.status, "not-requested");
  assert.equal(book.bookComplete, true);
  assert.equal(paths.length, 4);
});

test("a capped FMP candidate search is not complete identity evidence", async () => {
  const client = createFmpClient({ key: async () => "unit-only-credential", archive: async () => {}, fetch: async (input) => {
    const url = new URL(String(input));
    assert.equal(url.pathname, "/stable/search-name");
    assert.equal(url.searchParams.get("query"), "apple");
    return Response.json(Array.from({ length: 100 }, () => search.rows[0].row));
  } });
  const result = await client.searchNames("apple");
  assert.equal(result.complete, false);
  assert.equal(resolveHolding(payload.items[0], [], result, catalog).ticker, null);
});

test("owner SQL publishes saved holdings atomically, validates archived names and disables trade publishing", async () => {
  const db = new PGlite();
  try {
    await db.exec("create role anon; create role authenticated; create role service_role bypassrls;");
    for (const name of ["202609140001_fmp_store.sql", "202609140002_trade_indexes.sql", "202609140003_trade_index_period_alias.sql"]) {
      await db.exec(await readFile(new URL(`../supabase/migrations/${name}`, import.meta.url), "utf8"));
    }
    for (const b of [annual, search]) {
      const body = JSON.stringify(b.rows.map((r) => r.row)); const pg = b.pages[0];
      await db.query("insert into raw_batches values($1,$2,$3,$4,$5,$6,200,$7)", [contentHash(pg), pg.endpoint, pg.params, pg.fetchedAt, pg.payloadHash, pg.rowCount, body]);
    }
    const portfolio = { person: { id: pid, name: "Nancy Pelosi" }, state: "partial-disclosure-only", snapshots: [payload], activity: [], ingestion: { annual: { pages: annual.pages } } };
    await db.query("select save_fmp_portfolio($1,$2)", [portfolio, [snapshot]]);
    for (let version = 1; version <= 14; version++) {
      const document = { basis: "disclosed-trade-activity", version };
      await db.query("insert into index_versions(hash,person_id,snapshot_id,period,version,status,source_disclosure_hash,definition,document_text) values($1,$2,null,'2025-01-01',$3,'CANDIDATE',$1,$4,$5)", [contentHash(document), pid, version, document, JSON.stringify(document)]);
      await db.query("update people set index_hash=$1 where id=$2", [contentHash(document), pid]);
    }
    await db.exec(await readFile(new URL("../supabase/migrations/202609140004_holdings_indexes.sql", import.meta.url), "utf8"));
    assert.equal((await db.query<{ n: number }>("select count(*)::int n from index_versions where status='BLOCKED'")).rows[0].n, 14);
    assert.equal((await db.query<{ index_hash: string | null }>("select index_hash from people")).rows[0].index_hash, null);
    await db.query("update people set portfolio=$1 where id=$2", [{ snapshots: [{ id: "older-complete" }], indexInput: { snapshotId: "older-complete" } }, pid]);
    await db.query("select save_fmp_portfolio($1,$2)", [portfolio, [snapshot]]);
    assert.deepEqual((await db.query<{ portfolio: typeof portfolio }>("select portfolio from people")).rows[0].portfolio.snapshots, [payload]);
    await db.query("select save_fmp_portfolio($1,$2)", [{ ...portfolio, snapshots: [], state: "annual-source-unavailable" }, []]);
    assert.deepEqual((await db.query<{ portfolio: typeof portfolio }>("select portfolio from people")).rows[0].portfolio.snapshots, [payload]);
    const definition = buildHoldingsIndex(snapshot, resolutions)!;
    const publish = (d: typeof definition) => db.query("select publish_fmp_holdings_index($1,$2)", [contentHash(d), JSON.stringify(d)]);
    // Execute the actual service-only path, not a source-text assertion.
    await db.exec("set role service_role");
    await publish(definition);
    await publish(definition);
    assert.equal((await db.query<{ n: number }>("select count(*)::int n from index_versions where status='CANDIDATE'")).rows[0].n, 1);
    assert.equal((await db.query<{ n: number }>("select sum(weight_bps)::int n from constituents")).rows[0].n, 10000);
    const invalid = structuredClone(definition);
    invalid.evidence[0].candidates[0].row.name = "Fabricated candidate";
    await assert.rejects(publish(invalid), /invalid archived name evidence/);
    const wrongWeight = structuredClone(definition); wrongWeight.constituents[0].weightBps = 1;
    await assert.rejects(publish(wrongWeight), /weights must total/);
    await assert.rejects(db.query("select publish_fmp_trade_index($1,$2)", ["a".repeat(64), "{}"]), /permission denied/);
    assert.equal((await db.query<{ n: number }>("select count(*)::int n from index_versions")).rows[0].n, 15);
    assert.deepEqual((await db.query<{ payload: unknown }>("select payload from book_snapshots")).rows[0].payload, payload);
    assert.equal((await db.query<{ n: number }>("select count(*)::int n from disclosed_items")).rows[0].n, 4);
    const newer = batch("senate-net-worth", [{ ...annualRows[2], year: 2025, filingDate: "2026-05-15" }], false);
    const pg = newer.pages[0];
    await db.query("insert into raw_batches values($1,$2,$3,$4,$5,$6,200,$7)", [contentHash(pg), pg.endpoint, pg.params, pg.fetchedAt, pg.payloadHash, pg.rowCount, JSON.stringify(newer.rows.map((r) => r.row))]);
    const latest = annualSnapshots(newer, pid)[0];
    await db.query("select save_fmp_portfolio($1,$2)", [{ ...portfolio, snapshots: [latest], ingestion: { annual: { pages: newer.pages } } }, [{ id: contentHash(latest), payload: latest }]]);
    assert.equal((await db.query<{ n: number }>("select count(*)::int n from index_versions where status='CANDIDATE'")).rows[0].n, 0);
    assert.equal((await db.query<{ index_hash: string | null }>("select index_hash from people")).rows[0].index_hash, null);
    await assert.rejects(publish(definition), /latest saved holdings required/);
    await db.exec("reset role");
    for (const name of ["Apple Inc. (AAPL) [ST]", "IRA ⇒ NVIDIA Corporation - Common Stock (NVDA) [ST]"]) {
      assert.equal((await db.query<{ n: string }>("select fmp_holding_name($1) n", [name])).rows[0].n, holdingName(name));
    }
  } finally { await db.close(); }
});
