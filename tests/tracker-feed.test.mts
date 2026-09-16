import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import type { TrackerHandoff } from "../src/lib/tracker/tracker-parse.ts";

register("./support/ui-loader.mjs", import.meta.url);
const { TRACKER_FEED_DEFAULT_LIMIT, loadTrackerFeed, trackerDisclosures } = await import("../src/lib/tracker/feed.ts");
const { GET } = await import("../src/app/api/disclosures/route.ts");

const call = (url: string) => GET(new Request(url));

test("the feed is served from the committed bundle: many real dated rows", () => {
  const { disclosures, lane } = loadTrackerFeed();
  assert.ok(disclosures.length > 1000, `expected the bundle to yield a deep feed, got ${disclosures.length}`);
  assert.equal(lane.source, "pelositracker");
  assert.equal(lane.live, true);
  assert.equal(lane.count, disclosures.length);
});

test("every row carries honest provenance and never an exact price", () => {
  const { disclosures } = loadTrackerFeed();
  for (const row of disclosures) {
    assert.equal(row.source, "pelositracker");
    assert.ok(row.insiderName, "who filed it");
    assert.ok(row.profileId, "person id for the /p link");
    assert.match(row.transactionDate, /^\d{4}-\d{2}-\d{2}$/, "transaction date");
    assert.ok(row.filedAt, "disclosure date");
    assert.ok(row.ticker, "ticker");
    assert.ok(["buy", "sell", "other"].includes(row.side), "side");
    // A band is not a price and a filing is not a trade we executed.
    assert.equal(row.pricePerShare, null);
    assert.equal(row.transactionValue, null);
    assert.equal(row.sharesAmount, null);
    assert.equal(row.tradeEligible, false, "research-only: no tradability implied");
    assert.equal(row.venue, "none");
    // Value bands are bands: bounds only, never a single fabricated figure.
    if (row.amountLow !== null && row.amountHigh !== null) assert.ok(row.amountLow <= row.amountHigh);
  }
});

test("rows are sorted newest transaction first with a stable tiebreak", () => {
  const { disclosures } = loadTrackerFeed();
  for (let i = 1; i < disclosures.length; i++) {
    const prev = disclosures[i - 1];
    const cur = disclosures[i];
    const order = +new Date(cur.transactionDate) - +new Date(prev.transactionDate);
    assert.ok(order <= 0, `row ${i} is newer than the row before it`);
    if (order === 0) {
      const tie = cur.filedAt.localeCompare(prev.filedAt);
      assert.ok(tie <= 0 || (tie === 0 && prev.id.localeCompare(cur.id) <= 0));
    }
  }
});

test("GET /api/disclosures returns bundle rows and reports live lanes off as provenance", async () => {
  const response = await call("https://app.test/api/disclosures");
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.source, "pelositracker");
  assert.equal(body.lanes.insiders.source, "off");
  assert.equal(body.lanes.insiders.live, false);
  assert.ok(body.lanes.insiders.note, "off lanes explain why in the response, not hidden");
  assert.equal(body.lanes.congress.source, "off");
  assert.equal(body.lanes.tracker.source, "pelositracker");
  assert.equal(body.lanes.tracker.live, true);
  assert.equal(body.disclosures.length, TRACKER_FEED_DEFAULT_LIMIT);
  assert.ok(body.total > body.disclosures.length, "the full book stays behind paging");
  assert.equal(body.tradeEligibleCount, 0, "nothing on the feed implies a live copy");
  assert.equal(body.partial, true);
});

test("paging holds: pages are bounded, disjoint and cover the book", async () => {
  const first = await (await call("https://app.test/api/disclosures?page=1&limit=25")).json();
  const second = await (await call("https://app.test/api/disclosures?page=2&limit=25")).json();
  assert.equal(first.disclosures.length, 25);
  assert.equal(second.disclosures.length, 25);
  assert.equal(first.total, second.total);
  const firstIds = new Set(first.disclosures.map((row: { id: string }) => row.id));
  for (const row of second.disclosures) assert.ok(!firstIds.has(row.id), "page 2 does not repeat page 1");
  // A page past the end is empty, not a crash.
  const past = await (await call(`https://app.test/api/disclosures?page=${first.pageCount + 1}&limit=25`)).json();
  assert.equal(past.disclosures.length, 0);
  assert.equal(past.partial, false);
});

test("the ticker filter narrows the book", async () => {
  const body = await (await call("https://app.test/api/disclosures?ticker=NVDA&limit=500")).json();
  assert.ok(body.disclosures.length > 0, "expected NVDA prints in the bundle");
  for (const row of body.disclosures) assert.equal(row.ticker, "NVDA");
});

test("a missing or empty bundle degrades to an honest empty state, not a crash", () => {
  const empty = trackerDisclosures({ profiles: [] } as unknown as TrackerHandoff);
  assert.deepEqual(empty, []);
  const garbage = trackerDisclosures({} as unknown as TrackerHandoff);
  assert.deepEqual(garbage, []);
});
