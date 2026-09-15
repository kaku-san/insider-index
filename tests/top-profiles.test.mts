import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { createClient } from "@supabase/supabase-js";
import { createStoredPeopleService } from "../src/lib/fmp/store.ts";
import { createTopProfilesHandler } from "../src/lib/fmp/http.ts";
import { publishTopProfiles } from "../src/lib/fmp/publish.ts";
import {
  NO_NET_WORTH_SERIES, NO_SP_OVERLAY_SERIES, NO_YOY_SERIES, PINNED_PERSON_ID,
  rankPoliticianProfiles, type RankablePerson,
} from "../src/lib/fmp/top-profiles.ts";
import type { DisclosedItem, Person, Snapshot } from "../src/lib/fmp/types.ts";

function person(id: string, name: string): Person {
  const [firstName, lastName = "X"] = name.split(" ");
  return {
    id, provider: "fmp", providerId: id, name, firstName, lastName, chamber: "house",
    party: null, state: null, active: true, image: null, position: "Representative",
  };
}
function item(partial: Partial<DisclosedItem> & { id: string; personId: string }): DisclosedItem {
  return {
    year: 2024, referenceDate: "2024-12-31", filingDate: "2025-05-15", availableAt: null,
    name: "Asset", ticker: null, kind: "stock", section: "Asset", category: null, assetType: "Stock",
    formType: "House Report", owner: null, comment: null, debtDetails: null,
    valueRange: { low: 100, high: 200 }, providerValue: null, incomeRange: { low: null, high: null },
    providerIncome: null, incomeType: null, sourceUrl: null,
    source: { endpoint: "senate-net-worth", params: {}, fetchedAt: "2026-01-01T00:00:00.000Z", payloadHash: "x", rowCount: 1 },
    ordinal: 0, ...partial,
  };
}
function snapshot(personId: string, items: DisclosedItem[], complete = true): RankablePerson["snapshot"] {
  const payload: Snapshot = {
    id: `${personId}-snap`, personId, year: 2024, referenceDate: "2024-12-31", filingDate: "2025-05-15",
    sourceUrl: null, complete, partial: !complete, issues: complete ? [] : ["repeated-page"], items,
    stocks: items.filter((i) => i.kind === "stock"), etfs: items.filter((i) => i.kind === "etf"),
    options: items.filter((i) => i.kind === "option"), income: items.filter((i) => i.kind === "income"),
    liabilities: items.filter((i) => i.kind === "liability"), other: items.filter((i) => i.kind === "other"),
  };
  return { id: payload.id, payload };
}
function row(id: string, name: string, midpointLow: number, extra: Partial<RankablePerson> = {}): RankablePerson {
  return {
    person: person(id, name), bookState: "partial-disclosure-only",
    snapshot: snapshot(id, [item({ id: `${id}-h`, personId: id, valueRange: { low: midpointLow, high: midpointLow } })]),
    publishedIndex: null, ...extra,
  };
}
function omitted(body: { netWorth: unknown; yearOverYearReturn: unknown; sp500Overlay: unknown; netWorthReason: string; yearOverYearReturnReason: string; sp500OverlayReason: string }) {
  assert.equal(body.netWorth, null);
  assert.equal(body.yearOverYearReturn, null);
  assert.equal(body.sp500Overlay, null);
  assert.equal(body.netWorthReason, NO_NET_WORTH_SERIES);
  assert.equal(body.yearOverYearReturnReason, NO_YOY_SERIES);
  assert.equal(body.sp500OverlayReason, NO_SP_OVERLAY_SERIES);
}

test("ranks closed holding-band midpoints and pins Pelosi into the top 20", () => {
  const others = Array.from({ length: 24 }, (_, i) => row(`A${String(i).padStart(6, "0")}`, `Person ${i}`, (24 - i) * 1000));
  const pelosi = row(PINNED_PERSON_ID, "Nancy Pelosi", 1);
  const result = rankPoliticianProfiles([...others, pelosi]);
  assert.equal(result.listed, 20);
  assert.equal(result.universeSize, 25);
  assert.equal(result.methodology, "holding-band-midpoints");
  assert.equal(result.profiles[0].person.id, "A000000");
  assert.equal(result.profiles[0].estimatedValue.midpoint, 24000);
  assert.equal(result.profiles[0].rank, 1);
  assert.equal(result.profiles[19].person.id, PINNED_PERSON_ID);
  assert.equal(result.profiles[19].pinned, true);
  assert.equal(result.profiles[19].rank, 25);
  assert.equal(result.profiles[19].indexName, "Nancy P Index");
  assert.equal(result.pelosiPinned, true);
  assert.ok(!result.profiles.slice(0, 19).some((p) => p.person.id === PINNED_PERSON_ID));
  assert.ok(!result.profiles.some((p) => p.person.id === "A000019"));
  omitted(result);
  omitted(result.profiles[19]);
});

test("open bands, provider scalars, income and liabilities never become estimated value", () => {
  const richIncome = row("B000001", "Income Rich", 50, {
    snapshot: snapshot("B000001", [
      item({ id: "stock", personId: "B000001", kind: "stock", valueRange: { low: 100, high: 200 } }),
      item({ id: "open", personId: "B000001", kind: "stock", valueRange: { low: 9_999_999, high: null }, providerValue: 9_999_999 }),
      item({ id: "income", personId: "B000001", kind: "income", valueRange: { low: 1_000_000, high: 2_000_000 } }),
      item({ id: "debt", personId: "B000001", kind: "liability", valueRange: { low: 8_000_000, high: 9_000_000 } }),
    ]),
  });
  const result = rankPoliticianProfiles([richIncome, row(PINNED_PERSON_ID, "Nancy Pelosi", 10)]);
  const profile = result.profiles.find((p) => p.person.id === "B000001")!;
  assert.equal(profile.estimatedValue.midpoint, 150);
  assert.equal(profile.estimatedValue.low, 100);
  assert.equal(profile.estimatedValue.high, 200);
  assert.equal(profile.estimatedValue.valuedHoldings, 1);
  assert.equal(profile.estimatedValue.totalHoldings, 2);
  assert.equal(profile.dataQuality.estimateComplete, false);
  assert.equal(profile.dataQuality.partial, true);
  assert.equal(profile.holdings.length, 4);
  assert.ok(!profile.holdings.some((h) => h.valueRange.low === 0 || h.valueRange.high === 0));
});

test("keeps unmapped holdings and published weights without filtering the book", () => {
  const holdings = [
    item({ id: "mapped", personId: PINNED_PERSON_ID, name: "Apple", ticker: null, valueRange: { low: 100, high: 200 } }),
    item({ id: "private", personId: PINNED_PERSON_ID, name: "Family LLC", kind: "other", valueRange: { low: null, high: null } }),
  ];
  const result = rankPoliticianProfiles([{
    person: person(PINNED_PERSON_ID, "Nancy Pelosi"), bookState: "partial-disclosure-only",
    snapshot: snapshot(PINNED_PERSON_ID, holdings, false),
    publishedIndex: {
      hash: "a".repeat(64), period: "2024-12-31",
      definition: { methodology: "holding-band-midpoints", snapshotComplete: false },
      constituents: [{
        ticker: "AAPL", mint: "Mint111111111111111111111111111111111111111", issuer: "xstock", weight_bps: 10000,
        payload: { holdingIds: ["mapped"] },
      }],
    },
  }]);
  const profile = result.profiles[0];
  assert.equal(profile.holdings.length, 2);
  assert.equal(profile.holdings[0].tradable, true);
  assert.equal(profile.holdings[0].ticker, "AAPL");
  assert.equal(profile.holdings[1].tradable, false);
  assert.equal(profile.holdings[1].name, "Family LLC");
  assert.equal(profile.publishedWeights?.constituents[0].weightBps, 10000);
  assert.equal(profile.dataQuality.snapshotComplete, false);
  assert.deepEqual(profile.dataQuality.snapshotIssues, ["repeated-page"]);
});

test("people without books are omitted unless they are Pelosi", () => {
  const result = rankPoliticianProfiles([
    { person: person("C000001", "No Book"), bookState: "not-ingested", snapshot: null, publishedIndex: null },
    { person: person(PINNED_PERSON_ID, "Nancy Pelosi"), bookState: "not-ingested", snapshot: null, publishedIndex: null },
  ]);
  assert.equal(result.listed, 1);
  assert.equal(result.profiles[0].person.id, PINNED_PERSON_ID);
  assert.equal(result.profiles[0].estimatedValue.midpoint, null);
  assert.deepEqual(result.profiles[0].holdings, []);
  assert.deepEqual(result.profiles[0].dataQuality.snapshotIssues, ["no-annual-book"]);
});

function database(respond: (url: URL, init?: RequestInit) => unknown) {
  return createClient("https://saved.example.test", "test-only", { global: { fetch: async (input, init) => {
    const value = respond(new URL(String(input)), init);
    return value instanceof Response ? value : Response.json(value);
  } }, auth: { persistSession: false, autoRefreshToken: false } });
}

test("GET reads the persisted table only and keeps omitted series honest", async () => {
  const profile = rankPoliticianProfiles([row(PINNED_PERSON_ID, "Nancy Pelosi", 100)]).profiles[0];
  const requests: string[] = [];
  const handler = createTopProfilesHandler(createStoredPeopleService(database((url) => {
    requests.push(url.pathname);
    if (url.pathname.endsWith("top_politician_profiles")) return [{ list_order: 1, person_id: PINNED_PERSON_ID, payload: profile }];
    if (url.pathname.endsWith("fmp_store_state")) {
      return { payload: { universeSize: 540, netWorthReason: NO_NET_WORTH_SERIES, yearOverYearReturnReason: NO_YOY_SERIES, sp500OverlayReason: NO_SP_OVERLAY_SERIES }, saved_at: "2026-09-15" };
    }
    throw new Error(`unexpected ${url.pathname}`);
  })));
  const response = await handler();
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.storage, "supabase");
  assert.equal(body.published, true);
  assert.equal(body.listed, 1);
  assert.equal(body.universeSize, 540);
  assert.equal(body.profiles[0].person.id, PINNED_PERSON_ID);
  omitted(body);
  assert.ok(requests.every((path) => path.endsWith("top_politician_profiles") || path.endsWith("fmp_store_state")));
});

test("storage failures stay 502 without leaking upstream text", async () => {
  const handler = createTopProfilesHandler(createStoredPeopleService(database(() =>
    new Response(JSON.stringify({ message: "secret upstream URL", code: "DB" }), { status: 500 }))));
  const result = await handler();
  assert.equal(result.status, 502);
  assert.ok(!(await result.text()).includes("secret"));
});

test("publication adapter refuses a document without Pelosi before RPC", async () => {
  const calls: string[] = [];
  const db = database((url) => { calls.push(url.pathname); return null; });
  const missing = rankPoliticianProfiles([row("A000001", "Other One", 100)]);
  await assert.rejects(publishTopProfiles(db, missing), /pelosi-required/);
  assert.equal(calls.length, 0);
});

test("publication adapter uses only the atomic RPC", async () => {
  const calls: { path: string; body: Record<string, string> }[] = [];
  const db = database((url, init) => { calls.push({ path: url.pathname, body: JSON.parse(String(init?.body)) }); return null; });
  const document = rankPoliticianProfiles([row(PINNED_PERSON_ID, "Nancy Pelosi", 100)]);
  await publishTopProfiles(db, document);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, "/rest/v1/rpc/publish_top_politician_profiles");
  assert.deepEqual(JSON.parse(calls[0].body.p_document).profiles[0].person.id, PINNED_PERSON_ID);
});

function slim(id: string, rank: number, listOrder: number, pinned = id === PINNED_PERSON_ID): Record<string, unknown> {
  return {
    listOrder, rank, pinned, person: { id, name: id === PINNED_PERSON_ID ? "Nancy Pelosi" : id },
    estimatedValue: { midpoint: rank === 1 ? 500 : 1 },
    netWorth: null, netWorthReason: NO_NET_WORTH_SERIES,
    yearOverYearReturn: null, yearOverYearReturnReason: NO_YOY_SERIES,
    sp500Overlay: null, sp500OverlayReason: NO_SP_OVERLAY_SERIES,
  };
}
function document(profiles: ReturnType<typeof slim>[]): string {
  return JSON.stringify({
    source: "fmp", methodology: "holding-band-midpoints", universeSize: 3, listed: profiles.length,
    pelosiPinned: profiles.some((p) => (p.person as { id: string }).id === PINNED_PERSON_ID),
    profiles, netWorth: null, netWorthReason: NO_NET_WORTH_SERIES,
    yearOverYearReturn: null, yearOverYearReturnReason: NO_YOY_SERIES,
    sp500Overlay: null, sp500OverlayReason: NO_SP_OVERLAY_SERIES,
  });
}

test("owner SQL publishes atomically, requires Pelosi, and refuses invented series", async () => {
  const db = new PGlite();
  try {
    await db.exec("create role anon; create role authenticated; create role service_role bypassrls;");
    for (const name of ["202609140001_fmp_store.sql", "202609140002_trade_indexes.sql", "202609140003_trade_index_period_alias.sql", "202609140004_holdings_indexes.sql", "202609150003_top_politician_profiles.sql"]) {
      await db.exec(await readFile(new URL(`../supabase/migrations/${name}`, import.meta.url), "utf8"));
    }
    await db.query("insert into people(id,payload,book_state) values($1,$2,'not-ingested')", ["A000001", { id: "A000001", name: "Other One" }]);
    await db.exec("set role service_role");
    await assert.rejects(db.query("select publish_top_politician_profiles($1)", [document([slim("A000001", 1, 1, false)])]), /pelosi-required/);
    await db.exec("reset role");
    await db.query("insert into people(id,payload,book_state) values($1,$2,'not-ingested'),($3,$4,'not-ingested')", [
      PINNED_PERSON_ID, { id: PINNED_PERSON_ID, name: "Nancy Pelosi" },
      "A000002", { id: "A000002", name: "Other Two" },
    ]);
    const books = await db.query("select count(*)::int n from people");
    await db.exec("set role service_role");
    await assert.rejects(db.query("select publish_top_politician_profiles($1)", [document([slim("A000001", 1, 1, false)])]), /pelosi-required/);

    const invented = JSON.parse(document([slim(PINNED_PERSON_ID, 1, 1)])) as { netWorth: unknown };
    invented.netWorth = 12_000_000;
    await assert.rejects(db.query("select publish_top_politician_profiles($1)", [JSON.stringify(invented)]), /invented series not allowed/);
    await db.query("select publish_top_politician_profiles($1)", [document([slim("A000001", 1, 1, false), slim(PINNED_PERSON_ID, 2, 2)])]);
    await db.query("select publish_top_politician_profiles($1)", [document([slim(PINNED_PERSON_ID, 3, 1)])]);
    await db.exec("reset role");
    const rows = await db.query<{ person_id: string; list_order: number; pinned: boolean; n: number }>("select person_id, list_order, pinned from top_politician_profiles order by list_order");
    assert.equal(rows.rows.length, 1);
    assert.equal(rows.rows[0].person_id, PINNED_PERSON_ID);
    assert.equal(rows.rows[0].pinned, true);
    assert.equal((await db.query<{ n: number }>("select count(*)::int n from people")).rows[0].n, (books.rows[0] as { n: number }).n);
    await db.exec("set role service_role");
    await assert.rejects(db.query("insert into top_politician_profiles(list_order,person_id,rank,payload) values(1,$1,1,'{}')", [PINNED_PERSON_ID]), /permission denied/);
  } finally { await db.close(); }
});
