import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AInvestError,
  congressSideFromType,
  normalizeAInvestCongressRow,
  parseTradeSize,
  slugifyName,
  unwrapAInvestEnvelope,
} from "../src/lib/disclosures/ainvest-parse.ts";

test("unwrapAInvestEnvelope returns rows on status 0", () => {
  const rows = unwrapAInvestEnvelope({ data: { data: [{ name: "A" }] }, status_code: 0, status_msg: "success" });
  assert.deepEqual(rows, [{ name: "A" }]);
  assert.deepEqual(unwrapAInvestEnvelope({ data: null, status_code: 0 }), []);
  assert.deepEqual(unwrapAInvestEnvelope({ data: [{ name: "B" }], status_code: 0 }), [{ name: "B" }]);
});

test("unwrapAInvestEnvelope throws on HTTP-200 business errors", () => {
  assert.throws(
    () => unwrapAInvestEnvelope({ data: null, status_code: 4010, status_msg: "No auth, please add request header Authorization" }),
    (error: unknown) => error instanceof AInvestError && error.statusCode === 4010,
  );
  assert.throws(
    () => unwrapAInvestEnvelope({ data: null, status_code: 5112, status_msg: "The key is invalid" }),
    (error: unknown) => error instanceof AInvestError && error.statusCode === 5112,
  );
});

test("parseTradeSize handles STOCK Act buckets", () => {
  assert.deepEqual(parseTradeSize("$1K-$15K"), { low: 1_000, high: 15_000 });
  assert.deepEqual(parseTradeSize("$100K-$250K"), { low: 100_000, high: 250_000 });
  assert.deepEqual(parseTradeSize("$1M-$5M"), { low: 1_000_000, high: 5_000_000 });
  assert.deepEqual(parseTradeSize("$1,001 - $15,000"), { low: 1_001, high: 15_000 });
  assert.deepEqual(parseTradeSize("$250,001 – $500,000"), { low: 250_001, high: 500_000 });
  assert.deepEqual(parseTradeSize("$50M+"), { low: 50_000_000, high: null });
  assert.deepEqual(parseTradeSize("Over $50,000,000"), { low: 50_000_000, high: null });
  assert.deepEqual(parseTradeSize("$15K"), { low: 15_000, high: 15_000 });
});

test("parseTradeSize never fabricates a zero", () => {
  assert.deepEqual(parseTradeSize(""), { low: null, high: null });
  assert.deepEqual(parseTradeSize(null), { low: null, high: null });
  assert.deepEqual(parseTradeSize("N/A"), { low: null, high: null });
});

test("congressSideFromType maps buy/sell variants", () => {
  assert.equal(congressSideFromType("buy"), "buy");
  assert.equal(congressSideFromType("Purchase"), "buy");
  assert.equal(congressSideFromType("sell"), "sell");
  assert.equal(congressSideFromType("Sale (Partial)"), "sell");
  assert.equal(congressSideFromType("Sale (Full)"), "sell");
  assert.equal(congressSideFromType("Exchange"), "sell");
  assert.equal(congressSideFromType(""), "other");
  assert.equal(congressSideFromType(undefined), "other");
});

test("slugifyName is stable across honorifics and accents", () => {
  assert.equal(slugifyName("Nancy Pelosi"), "nancy-pelosi");
  assert.equal(slugifyName("Rep. Josh Gottheimer"), "josh-gottheimer");
  assert.equal(slugifyName("Hon. Michael T. McCaul Jr."), "michael-t-mccaul");
  assert.equal(slugifyName("Raúl Grijalva"), "raul-grijalva");
});

test("normalizeAInvestCongressRow builds a copyable row with a range and no fake shares", () => {
  const row = normalizeAInvestCongressRow(
    {
      name: "Nancy Pelosi",
      party: "Democrat",
      state: "ca",
      trade_date: "2026-08-28",
      filing_date: "2026-09-11",
      reporting_gap: "14 Days",
      trade_type: "buy",
      size: "$1M-$5M",
    },
    "nvda",
  );
  assert.ok(row);
  assert.equal(row.ticker, "NVDA");
  assert.equal(row.slug, "nancy-pelosi");
  assert.equal(row.id, "ainvest-nancy-pelosi-NVDA-2026-08-28-buy-1000000");
  assert.equal(row.party, "Democrat");
  assert.equal(row.state, "CA");
  assert.equal(row.side, "buy");
  assert.equal(row.amountLow, 1_000_000);
  assert.equal(row.amountHigh, 5_000_000);
  assert.equal(row.sizeLabel, "$1M-$5M");
  assert.equal(row.filingDate, "2026-09-11");
  assert.equal(row.reportingGap, "14 Days");
});

test("normalizeAInvestCongressRow accepts US dates and falls back filing→trade date", () => {
  const row = normalizeAInvestCongressRow(
    { name: "Dan Crenshaw", party: "Republican", state: "TX", trade_date: "08/04/2026", trade_type: "sell", size: "$15K-$50K" },
    "TSLA",
  );
  assert.ok(row);
  assert.equal(row.tradeDate, "2026-08-04");
  assert.equal(row.filingDate, "2026-08-04");
  assert.equal(row.side, "sell");
});

test("normalizeAInvestCongressRow drops nameless rows", () => {
  assert.equal(normalizeAInvestCongressRow({ trade_type: "buy" }, "NVDA"), null);
  assert.equal(normalizeAInvestCongressRow({ name: "X" }, ""), null);
});

test("normalizeAInvestCongressRow honours a ticker and size alias carried on the row", () => {
  const row = normalizeAInvestCongressRow(
    { name: "Nancy Pelosi", party: "Democrat", state: "CA", trade_date: "2026-08-28", filing_date: "2026-09-11", trade_type: "buy", ticker: "avgo", amount: "$15K-$50K" },
    "NVDA",
  );
  assert.ok(row);
  assert.equal(row.ticker, "AVGO");
  assert.equal(row.amountLow, 15_000);
  assert.equal(row.amountHigh, 50_000);
  assert.equal(row.sizeLabel, "$15K-$50K");
});
