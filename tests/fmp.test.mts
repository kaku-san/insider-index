import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createFmpClient, type RawCapture } from "../src/lib/fmp/client.ts";
import { supabaseArchive } from "../src/lib/fmp/ingest.ts";
import { annualSnapshots, mapDisclosedTicker, normalizeActivity, normalizeAnnual, normalizePerson, selectIndexInput } from "../src/lib/fmp/fmp-parse.ts";
import { createPeopleService } from "../src/lib/fmp/service.ts";
import { createPeopleHandlers } from "../src/lib/fmp/http.ts";
import { indexCatalog, type CatalogToken } from "../src/lib/venues/catalog-parse.ts";
import type { Batch, FmpRow } from "../src/lib/fmp/types.ts";

const recorded = async (name: string) => JSON.parse(await readFile(new URL(`./fixtures/fmp/${name}.json`, import.meta.url), "utf8")) as { payload: FmpRow[]; fetchedAt: string };
const annual = await recorded("senate-net-worth");
const profile = await recorded("senate-profile-person");
const stockCatalog = JSON.parse(await readFile(new URL("../src/lib/venues/catalog-snapshot.json", import.meta.url), "utf8")) as { xstocks: CatalogToken[]; backpack: CatalogToken[] };
const catalog = indexCatalog([...stockCatalog.backpack, ...stockCatalog.xstocks]);
const id = "L000397";
const key = "test-only-not-a-provider-credential";
const at = new Date("2026-09-14T00:00:00Z");
function clientFor(fetcher: (url: URL, init?: RequestInit) => Promise<Response>, options: Parameters<typeof createFmpClient>[0] = {}) {
  return createFmpClient({ key: async () => key, fetch: (async (url, init) => fetcher(new URL(String(url)), init)) as typeof fetch,
    archive: async () => {}, now: () => at, sleep: async () => {}, retries: 0, ...options });
}
function batch(rows: FmpRow[], complete = true): Batch {
  const source = { endpoint: "senate-net-worth" as const, params: { senateID: id, page: 0, limit: 250 }, fetchedAt: at.toISOString(), payloadHash: createHash("sha256").update(JSON.stringify(rows)).digest("hex"), rowCount: rows.length };
  return { endpoint: source.endpoint, status: complete ? "complete" : "partial", complete, rows: rows.map((row, ordinal) => ({ row, ordinal, source })), pages: [source], issues: [] };
}
const syntheticEquity = (overrides: FmpRow = {}): FmpRow => ({
  senateID: id, formType: "House Report", year: 2024, filingDate: "2025-05-09", section: "Asset", name: "Apple Inc.",
  symbol: "AAPL", assetType: "Stock", owner: "Spouse", valueRange: { min: 1001, max: 15000 },
  link: "https://disclosures-clerk.house.gov/public_disc/financial-pdfs/2024/10066636.pdf", ...overrides,
});

test("recorded profiles identify both chambers with stable IDs, not name slugs", async () => {
  const people = (await recorded("senate-profile")).payload.map(normalizePerson);
  assert.equal(people[0]?.id, id);
  assert.equal(people[0]?.chamber, "house");
  assert.equal(normalizePerson({ ...profile.payload[0], firstName: "Changed", latestPosition: "Senator", active: false })?.id, id);
  assert.equal(normalizePerson({ firstName: "Nancy", lastName: "Pelosi" }), null);
});

test("pagination continues after a short page and includes verified empty terminator", async () => {
  const calls: URL[] = [], captures: RawCapture[] = [];
  const client = clientFor(async (url, init) => {
    calls.push(url);
    assert.equal(new Headers(init?.headers).get("apikey"), key);
    assert.equal(url.searchParams.has("apikey"), false);
    assert.equal(init?.redirect, "error");
    const page = Number(url.searchParams.get("page"));
    return Response.json(page < 2 ? [{ ...profile.payload[0], senateID: page ? "N000193" : id }] : []);
  }, { archive: async (capture) => { captures.push(capture); } });
  const result = await client.profiles();
  assert.equal(result.complete, true);
  assert.equal(result.rows.length, 2);
  assert.deepEqual(calls.map((u) => u.searchParams.get("page")), ["0", "1", "2"]);
  assert.equal(captures.length, 3);
  assert.equal(captures[2].rowCount, 0);
  assert.equal(JSON.stringify(captures).includes(key), false);
});

test("recorded annual repeated pages retain all 250 rows once but are partial, never an index", async () => {
  const repeat = await recorded("senate-net-worth-page1");
  assert.deepEqual(repeat.payload, annual.payload);
  const result = await clientFor(async (url) => Response.json(url.searchParams.get("page") === "0" ? annual.payload : repeat.payload)).annual(id);
  assert.equal(result.complete, false);
  assert.equal(result.status, "partial");
  assert.equal(result.rows.length, 250);
  assert.equal(result.pages.length, 2);
  assert.equal(result.issues[0].code, "repeated-page");
  const snapshots = annualSnapshots(result, id);
  assert.equal(snapshots.reduce((n, s) => n + s.items.length, 0), 250);
  assert.ok(snapshots.every((s) => !s.complete));
  assert.equal(selectIndexInput(snapshots, catalog).snapshotId, null);
});

test("HTTP, error JSON and malformed success responses are failures, not empty books", async () => {
  for (const response of [
    () => Response.json({ "Error Message": key }, { status: 403 }),
    () => Response.json({ "Error Message": key }),
    () => Response.json([{ error: "subscription" }]),
    () => Response.json({ data: [] }),
    () => new Response("not json"),
    () => Response.json([null]),
  ]) {
    const captures: RawCapture[] = [];
    const result = await clientFor(async () => response(), { archive: async (c) => { captures.push(c); } }).annual(id);
    assert.equal(result.status, "failed");
    assert.equal(result.complete, false);
    assert.equal(result.issues.length, 1);
    assert.equal(JSON.stringify({ result, captures }).includes(key), false);
  }
  const result = await clientFor(async () => { throw new Error(`https://provider?apikey=${key}`); }).annual(id);
  assert.equal(result.issues[0].code, "network");
  assert.equal(JSON.stringify(result).includes(key), false);
});

test("later page failure and safety cap preserve partial results", async () => {
  const client = clientFor(async (url) => Number(url.searchParams.get("page")) === 0 ? Response.json(profile.payload) : Response.json({}, { status: 429 }));
  const failed = await client.profiles();
  assert.equal(failed.status, "partial");
  assert.equal(failed.rows.length, 1);
  assert.equal(failed.issues[0].httpStatus, 429);
  const capped = await clientFor(async () => Response.json(profile.payload), { maxPages: 1 }).profiles();
  assert.equal(capped.complete, false);
  assert.equal(capped.issues[0].code, "page-limit");
});

test("retryable failures respect Retry-After; auth errors do not retry", async () => {
  const waits: number[] = [];
  let calls = 0;
  const client = clientFor(async () => ++calls === 1 ? Response.json({}, { status: 429, headers: { "Retry-After": "2" } }) : Response.json([]),
    { retries: 2, sleep: async (ms) => { waits.push(ms); } });
  assert.equal((await client.houseLatest()).complete, true);
  assert.deepEqual(waits, [2000]);
  calls = 0;
  await clientFor(async () => { calls++; return Response.json({}, { status: 401 }); }, { retries: 2 }).senateLatest();
  assert.equal(calls, 1);
});

test("every endpoint uses senateID even House; aggregate is a documented single series", async () => {
  const calls: URL[] = [];
  const client = clientFor(async (url) => { calls.push(url); return Response.json([]); });
  await client.profiles(id); await client.annual(id); await client.aggregates(id);
  await client.houseTrades(id); await client.senateTrades(id); await client.houseLatest(); await client.senateLatest();
  assert.deepEqual(calls.map((u) => u.pathname.split("/").at(-1)), ["senate-profile", "senate-net-worth", "senate-net-worth-aggregated", "house-trades-by-id", "senate-trades-by-id", "house-latest", "senate-latest"]);
  for (const call of calls.slice(0, 5)) assert.equal(call.searchParams.get("senateID"), id);
  assert.equal(calls[2].searchParams.has("page"), false);
  assert.equal(calls[1].searchParams.get("limit"), "250");
});

test("default client and people handlers work with all filesystem writes denied", () => {
  // A child permission boundary is deterministic even when tests run as root.
  // Unlike chmod, it rejects writes on every host without touching the app disk.
  const output = execFileSync(process.execPath, [
    "--permission", "--allow-fs-read=*", "--experimental-strip-types", "--input-type=module", "--eval", `
      import assert from "node:assert/strict";
      import { createFmpClient } from ${JSON.stringify(new URL("../src/lib/fmp/client.ts", import.meta.url).href)};
      import { createPeopleService } from ${JSON.stringify(new URL("../src/lib/fmp/service.ts", import.meta.url).href)};
      import { createPeopleHandlers } from ${JSON.stringify(new URL("../src/lib/fmp/http.ts", import.meta.url).href)};
      assert.equal(process.permission.has("fs.write"), false);
      const client = createFmpClient({
        key: async () => "test-only-key",
        fetch: async (input) => {
          const url = new URL(input);
          return Response.json(url.pathname.endsWith("senate-profile") && url.searchParams.get("page") === "0"
            ? ${JSON.stringify(profile.payload)} : []);
        },
      });
      const handlers = createPeopleHandlers(createPeopleService(client, async () => new Map()));
      const directory = await handlers.directory(new Request("https://app.test/api/people"));
      assert.equal(directory.status, 200);
      assert.equal((await directory.json()).count, 1);
      const portfolio = await handlers.portfolio(new Request("https://app.test"), { params: Promise.resolve({ id: "${id}" }) });
      assert.equal(portfolio.status, 200);
      const book = await portfolio.json();
      assert.equal(book.person.id, "${id}");
      assert.equal(book.ingestion.annual.status, "complete");
      assert.equal(book.state, "no-annual-book");
      console.log("read-only-ok");
    `,
  ], { encoding: "utf8" });
  assert.equal(output.trim(), "read-only-ok");
});

test("Supabase archive persists redacted bytes and metadata; storage failures still fail ingestion", async () => {
  const inserts: Record<string, unknown>[] = [];
  let error: { message: string } | null = null;
  const db = { from(table: string) {
    assert.equal(table, "raw_batches");
    return { async insert(row: Record<string, unknown>) { inserts.push(row); return { error }; } };
  } } as unknown as SupabaseClient;
  const archive = supabaseArchive(db);
  const result = await clientFor(async () => Response.json({ "Error Message": `secret=${key}` }), { archive }).annual(id);
  assert.equal(result.issues[0].code, "payload");
  assert.equal(inserts.length, 1);
  const capture = inserts[0];
  assert.equal(capture.body, JSON.stringify({ "Error Message": "secret=[REDACTED]" }));
  assert.equal(capture.payload_hash, createHash("sha256").update(capture.body as string).digest("hex"));
  assert.deepEqual(capture.params, { senateID: id, page: 0, limit: 250 });
  assert.equal(capture.fetched_at, at.toISOString());
  assert.equal(capture.http_status, 200);
  assert.equal(capture.endpoint, "senate-net-worth");

  const client = clientFor(async () => Response.json([]), { archive });
  assert.equal((await client.annual(id)).complete, true);
  assert.equal(inserts[1].body, "[]");
  assert.equal(inserts[1].row_count, 0);
  error = { message: `storage unavailable ${key}` };
  const failed = await client.annual(id);
  assert.equal(failed.status, "failed");
  assert.equal(failed.issues[0].code, "storage");
  assert.equal(JSON.stringify(failed).includes(key), false);
});

test("normalization preserves annual rows, all years, owner, no-ticker assets, income and liabilities", () => {
  const source = batch(annual.payload);
  const snapshots = annualSnapshots(source, id);
  assert.equal(snapshots.reduce((sum, s) => sum + s.items.length, 0), annual.payload.length);
  const latest = snapshots.find((s) => s.year === 2024)!;
  assert.ok(latest.items.length > 15);
  assert.ok(latest.items.some((i) => i.owner === "Joint"));
  assert.ok(latest.income.length > 0);
  assert.ok(latest.liabilities.length > 0);
  assert.ok(latest.etfs.length > 15);
  assert.ok(latest.items.every((i) => i.ticker === null));
  assert.deepEqual(latest.income[0].valueRange, { low: null, high: null });
  assert.equal(latest.income[0].providerValue, null);
  assert.equal(latest.referenceDate, "2024-12-31");
  const selected = selectIndexInput(snapshots, catalog);
  assert.equal(selected.year, 2024);
  assert.equal(selected.items.length, latest.stocks.length + latest.etfs.length);
  assert.ok(selected.items.every((i) => i.disclosureOnly));
});

test("duplicates retain distinct row identities; options never become underlying-stock exposure", () => {
  const source = batch([syntheticEquity(), syntheticEquity(), syntheticEquity({ assetType: "Stock Option" }), syntheticEquity({ section: "Income" }), syntheticEquity({ section: "Liabilities" })]);
  const [snapshot] = annualSnapshots(source, id);
  assert.equal(snapshot.items.length, 5);
  assert.equal(new Set(snapshot.items.map((i) => i.id)).size, 5);
  assert.equal(snapshot.options.length, 1);
  const option = mapDisclosedTicker(snapshot.options[0], catalog);
  assert.equal(option.token, null);
  assert.equal(option.mappingReason, "ineligible-instrument");
  assert.equal(selectIndexInput([snapshot], catalog).items.length, 2);
  const unknown = normalizeAnnual({ ...source.rows[0], row: syntheticEquity({ valueRange: { min: 50000000, max: null }, value: 75000000 }) }, id);
  assert.deepEqual(unknown.valueRange, { low: 50000000, high: null });
});

test("amendments stay separate, unreconciled versions block selection; older complete year can be selected", () => {
  const rows = [syntheticEquity(), syntheticEquity({ filingDate: "2025-06-01", link: "https://example.org/amendment.pdf" }),
    syntheticEquity({ year: 2023, filingDate: "2024-05-01", link: "https://example.org/2023.pdf" })];
  const snapshots = annualSnapshots(batch(rows), id);
  assert.equal(snapshots.length, 3);
  assert.ok(snapshots.filter((s) => s.year === 2024).every((s) => s.issues.includes("unreconciled-versions")));
  assert.equal(selectIndexInput(snapshots, catalog).year, 2023);
  const missing = annualSnapshots(batch([syntheticEquity({ filingDate: "bad" })]), id);
  assert.equal(missing[0].complete, false);
});

test("pure catalog mapping prefers actual xStock then Backpack and retains unmapped securities", () => {
  const both = stockCatalog.xstocks.find((x) => stockCatalog.backpack.some((b) => b.ticker === x.ticker))!;
  const item = { ticker: both.ticker, kind: "stock" as const };
  assert.equal(mapDisclosedTicker(item, catalog).token?.issuer, "xstock");
  const backpack = indexCatalog(stockCatalog.backpack);
  assert.equal(mapDisclosedTicker(item, backpack).token?.issuer, "backpack");
  assert.equal(mapDisclosedTicker({ ...item, ticker: "NOTINCATALOG" }, catalog).disclosureOnly, true);
  assert.equal(mapDisclosedTicker({ ...item, ticker: null }, catalog).mappingReason, "unresolved-security");
  assert.deepEqual(item, { ticker: both.ticker, kind: "stock" });
});

test("recorded PTR schema retains spouse, dollar band and bond instrument; missing latest person ID stays unresolved", async () => {
  const house = (await recorded("house-trades-by-id")).payload;
  const activity = normalizeActivity(batch(house).rows[0]);
  assert.equal(activity.owner, "Spouse");
  assert.equal(activity.kind, "other");
  assert.deepEqual(activity.amount, { low: 1001, high: 15000 });
  assert.equal(mapDisclosedTicker(activity, catalog).token, null);
  const latest = normalizeActivity(batch((await recorded("house-latest")).payload).rows[0]);
  assert.equal(latest.personId, null);
  const senate = normalizeActivity(batch((await recorded("senate-trades-by-id")).payload).rows[1]);
  assert.equal(senate.kind, "etf");
});

async function replayService(config: { repeatAnnual?: boolean; failAnnual?: boolean; trades?: FmpRow[] } = {}) {
  const aggregates = (await recorded("senate-net-worth-aggregated")).payload;
  const client = clientFor(async (url) => {
    const endpoint = url.pathname.split("/").at(-1);
    const page = Number(url.searchParams.get("page"));
    if (endpoint === "senate-net-worth") {
      if (config.failAnnual) return Response.json({ "Error Message": "denied" }, { status: 403 });
      return Response.json(config.repeatAnnual || page === 0 ? annual.payload : []);
    }
    if (page > 0) return Response.json([]);
    if (endpoint === "senate-profile") return Response.json(profile.payload);
    if (endpoint === "senate-net-worth-aggregated") return Response.json(aggregates);
    if (endpoint === "house-trades-by-id") return Response.json(config.trades ?? []);
    return Response.json([]);
  });
  return createPeopleService(client, async () => catalog);
}

test("person API keeps later activity separate; no annual failure is disguised as an empty complete book", async () => {
  const before = await (await replayService()).portfolio(id);
  const after = await (await replayService({ trades: [{ ...syntheticEquity(), assetDescription: "Apple", transactionDate: "2026-01-01", disclosureDate: "2026-02-01", type: "Sale", amount: "$50M+" }] })).portfolio(id);
  assert.deepEqual(after.indexInput, before.indexInput);
  assert.deepEqual(after.snapshots, before.snapshots);
  assert.equal(after.activity[0].sinceReport, true);
  assert.deepEqual(after.activity[0].amount, { low: 50000000, high: null });
  assert.equal(after.annualAggregates[0].reconciled, false);
  const failed = await (await replayService({ failAnnual: true })).portfolio(id);
  assert.equal(failed.partial, true);
  assert.equal(failed.ingestion.annual.status, "failed");
  assert.equal(failed.state, "annual-source-unavailable");
  assert.equal(failed.indexInput.snapshotId, null);
  const repeated = await (await replayService({ repeatAnnual: true })).portfolio(id);
  assert.equal(repeated.state, "partial-disclosure-only");
});

test("executable HTTP handlers provide searchable directory, portfolio and safe errors without fake people", async () => {
  const service = await replayService();
  const handlers = createPeopleHandlers(service);
  const matched = await handlers.directory(new Request("https://app.test/api/people?q=lofgren"));
  assert.equal(matched.status, 200);
  assert.equal((await matched.json()).count, 1);
  const unmatched = await handlers.directory(new Request("https://app.test/api/people?q=pelosi"));
  assert.equal((await unmatched.json()).count, 0);
  const portfolio = await handlers.portfolio(new Request("https://app.test"), { params: Promise.resolve({ id }) });
  assert.equal(portfolio.status, 200);
  assert.equal((await portfolio.json()).person.id, id);
  const invalid = await handlers.portfolio(new Request("https://app.test"), { params: Promise.resolve({ id: "../../secret" }) });
  assert.equal(invalid.status, 400);
  const empty = createPeopleHandlers(createPeopleService(clientFor(async () => Response.json([])), async () => catalog));
  assert.equal((await empty.portfolio(new Request("https://app.test"), { params: Promise.resolve({ id }) })).status, 404);
  const off = createPeopleHandlers(createPeopleService(clientFor(async () => { throw new Error("must not fetch"); }, { key: async () => null }), async () => catalog));
  const unavailable = await off.directory(new Request("https://app.test/api/people"));
  assert.equal(unavailable.status, 503);
  assert.deepEqual(await unavailable.json(), { source: "fmp", error: "fmp-unavailable", complete: false, partial: true });
});

test("source corrections create new snapshot identities; unchanged observations retain identities", () => {
  const original = annualSnapshots(batch([syntheticEquity()]), id)[0];
  const unchanged = annualSnapshots(batch([syntheticEquity()]), id)[0];
  const corrected = annualSnapshots(batch([syntheticEquity({ valueRange: { min: 15001, max: 50000 } })]), id)[0];
  assert.equal(original.id, unchanged.id);
  assert.notEqual(original.id, corrected.id);
});

test("malformed profile data is an upstream failure, not a false 404", async () => {
  const handlers = createPeopleHandlers(createPeopleService(clientFor(async (url) => Response.json(Number(url.searchParams.get("page")) ? [] : [{ senateID: id }])), async () => catalog));
  const response = await handlers.portfolio(new Request("https://app.test"), { params: Promise.resolve({ id }) });
  assert.equal(response.status, 502);
  assert.equal((await response.json()).complete, false);
});

test("mismatched person records cannot produce a complete source input", async () => {
  const service = createPeopleService(clientFor(async (url) => {
    if (Number(url.searchParams.get("page")) > 0) return Response.json([]);
    if (url.pathname.endsWith("senate-profile")) return Response.json(profile.payload);
    if (url.pathname.endsWith("senate-net-worth")) return Response.json([syntheticEquity({ senateID: "T000278" })]);
    return Response.json([]);
  }), async () => catalog);
  const result = await service.portfolio(id);
  assert.equal(result.complete, false);
  assert.equal(result.indexInput.snapshotId, null);
  assert.equal(result.ingestion.annual.issues[0].code, "identity");
});
