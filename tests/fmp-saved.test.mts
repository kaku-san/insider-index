import test from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";
import { createStoredPeopleService, readRows } from "../src/lib/fmp/store.ts";
import { createPeopleHandlers } from "../src/lib/fmp/http.ts";
import { publishTradeIndex } from "../src/lib/fmp/publish.ts";
import { buildTradeIndex } from "../src/lib/fmp/trade-index.ts";
import { indexCatalog } from "../src/lib/venues/catalog-parse.ts";
import type { Activity } from "../src/lib/fmp/types.ts";

function database(respond: (url: URL, init?: RequestInit) => unknown) {
  return createClient("https://saved.example.test", "test-only", { global: { fetch: async (input, init) => {
    const value = respond(new URL(String(input)), init);
    return value instanceof Response ? value : Response.json(value);
  } }, auth: { persistSession: false, autoRefreshToken: false } });
}
const person = { id: "P000197", name: "Nancy Pelosi", provider: "fmp", providerId: "P000197", chamber: "house", party: "Democrat", state: "CA", active: true, image: null, firstName: "Nancy", lastName: "Pelosi", position: "Representative" };

test("saved directory exhausts REST pages and keeps complete provider metadata", async () => {
  const rows = Array.from({ length: 540 }, (_, i) => ({ payload: { ...person, id: `P${String(i).padStart(6, "0")}` }, book_state: "partial-disclosure-only" }));
  const requests: string[] = [];
  const db = database((url, init) => {
    requests.push(url.pathname);
    assert.ok(!init?.method || init.method === "GET");
    if (url.pathname.endsWith("fmp_store_state")) return { payload: { complete: true, unnormalizedCount: 0, ingestion: { count: 540, status: "complete", complete: true, partial: false, pages: [], issues: [] } }, saved_at: "2026-09-14" };
    if (url.pathname.endsWith("index_versions")) return [];
    const from = Number(url.searchParams.get("offset") ?? 0), limit = Number(url.searchParams.get("limit") ?? 200);
    return rows.slice(from, from + limit);
  });
  const result = await createPeopleHandlers(createStoredPeopleService(db)).directory(new Request("https://app.test/api/people?q=pelosi"));
  assert.equal(result.status, 200);
  const body = await result.json();
  assert.equal(body.total, 540);
  assert.equal(body.people.length, 540);
  assert.equal(body.complete, true);
  assert.equal(body.storage, "supabase");
  assert.equal(requests.filter((p) => p.endsWith("people")).length, 3);
});
test("partial saved books return unchanged with no FMP request or archive; absent downloads stay honest", async () => {
  const snapshots = [{ id: "annual", complete: false, items: [{ name: "Apple Inc [ST]", ticker: null, valueRange: { low: null, high: null }, mappingReason: "no-source-symbol" }] }];
  const original = structuredClone(snapshots);
  const service = createStoredPeopleService(database((url) => {
    if (url.pathname.endsWith("index_versions")) return null;
    assert.ok(url.pathname.endsWith("people"));
    return { payload: person, portfolio: { person, snapshots, activity: [], complete: false, partial: true, bookComplete: false, state: "partial-disclosure-only" }, saved_at: "2026-09-14" };
  }));
  const response = await createPeopleHandlers(service).portfolio(new Request("https://app.test"), { params: Promise.resolve({ id: person.id }) });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.partial, true);
  assert.equal(body.bookComplete, false);
  assert.deepEqual(body.snapshots, original);
  assert.deepEqual(snapshots, original);
  const missing = await createStoredPeopleService(database((url) => url.pathname.endsWith("index_versions") ? null : { payload: person, portfolio: null, saved_at: null })).portfolio(person.id);
  assert.equal(missing.state, "not-ingested");
  assert.equal(missing.complete, false);
  assert.deepEqual(missing.snapshots, []);
});
test("storage failures remain safe and no result claims complete after failed pagination", async () => {
  await assert.rejects(readRows(async () => ({ data: null, error: new Error("private failure") })), /saved-data-unavailable/);
  const handlers = createPeopleHandlers(createStoredPeopleService(database(() => new Response(JSON.stringify({ message: "secret upstream URL", code: "DB" }), { status: 500 }))));
  const result = await handlers.directory(new Request("https://app.test/api/people"));
  assert.equal(result.status, 502);
  assert.ok(!(await result.text()).includes("secret"));
});
test("publication adapter uses only the atomic RPC and stable documents, never book writes", async () => {
  const calls: { path: string; body: Record<string, string> }[] = [];
  const db = database((url, init) => { calls.push({ path: url.pathname, body: JSON.parse(String(init?.body)) }); return null; });
  const activity = { id: "trade", personId: person.id, ticker: "AAPL", kind: "stock", amount: { low: 100, high: 200 }, transactionDate: "2025-01-01" } as Activity;
  const definition = buildTradeIndex(person.id, [activity], indexCatalog([{ ticker: "AAPL", mint: "catalog-mint", issuer: "xstock", symbol: "AAPLx", name: "Apple", decimals: 8 }]))!;
  const hash = await publishTradeIndex(db, definition);
  assert.equal(await publishTradeIndex(db, definition), hash);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].path, "/rest/v1/rpc/publish_fmp_trade_index");
  assert.equal(calls[0].body.p_hash, hash);
  assert.deepEqual(JSON.parse(calls[0].body.p_document), definition);
});
test("a partial saved annual book can show a fully published one-mint target", async () => {
  const hash = "b".repeat(64);
  const index = { hash, person_id: person.id, constituents: [{ ticker: "AAPL", mint: "saved-mint", weight_bps: 10000 }] };
  const db = database((url) => {
    if (url.pathname.endsWith("people")) return { payload: person, portfolio: { snapshots: [], activity: [], bookComplete: false, partial: true, complete: false, state: "partial-disclosure-only" } };
    return url.searchParams.has("hash") ? index : { hash };
  });
  const result = await createStoredPeopleService(db).portfolio(person.id);
  assert.equal(result.bookComplete, false);
  assert.equal(result.partial, true);
  assert.equal(result.publishedIndex?.constituents[0].weight_bps, 10000);
});
test("reader refuses incomplete published targets rather than showing partial weights", async () => {
  const db = database(() => ({ hash: "a".repeat(64), constituents: [{ ticker: "AAPL", weight_bps: 100 }] }));
  await assert.rejects(createStoredPeopleService(db).publishedIndex("a".repeat(64)), /incomplete-index-publication/);
});
