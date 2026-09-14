import test from "node:test";
import assert from "node:assert/strict";
import { buildTradeIndex, contentHash } from "../src/lib/fmp/trade-index.ts";
import { indexCatalog, type CatalogToken } from "../src/lib/venues/catalog-parse.ts";
import type { Activity } from "../src/lib/fmp/types.ts";

const token = (ticker: string, issuer: CatalogToken["issuer"]): CatalogToken => ({ ticker, issuer, mint: `${issuer}-${ticker}`, symbol: ticker, name: ticker, decimals: 8 });
const catalog = indexCatalog([token("AAPL", "backpack"), token("AAPL", "xstock"), token("MSFT", "backpack"), token("TSLA", "xstock")]);
function trade(id: string, ticker: string | null, low: number | null = 100, high: number | null = 300): Activity {
  return { id, ticker, amount: { low, high }, personId: "P000197", kind: "stock", name: "Not a ticker", event: "Purchase", transactionDate: "2025-01-02", disclosureDate: "2025-01-10", owner: null, amountLabel: null, assetType: null, comment: null, sourceUrl: null, ordinal: 0, source: { endpoint: "house-trades-by-id", params: { senateID: "P000197" }, fetchedAt: "2025-02-01", payloadHash: "source", rowCount: 1 } };
}
test("publishes from trade symbols alone, preferring xStock and retaining exclusions without mutating books/activity", () => {
  const trades = [trade("1", "AAPL"), trade("2", "MSFT", 600, 600), trade("3", "UNKNOWN"), trade("4", null), { ...trade("5", "TSLA"), kind: "option" as const }];
  const before = structuredClone(trades);
  const result = buildTradeIndex("P000197", trades, catalog)!;
  assert.equal(result.methodology, "trade-band-midpoints");
  assert.deepEqual(result.constituents.map((c) => [c.ticker, c.issuer, c.weightBps]), [["AAPL", "xstock", 2500], ["MSFT", "backpack", 7500]]);
  assert.deepEqual(result.excluded.map((c) => c.reason), ["no-solana-mint", "no-source-symbol", "ineligible-instrument"]);
  assert.deepEqual(trades, before);
  assert.match(result.label, /not current holdings/);
});
test("one unknown/open band switches the entire basket to labelled equal weights with exact rounding", () => {
  const result = buildTradeIndex("P000197", [trade("1", "AAPL", 100, null), trade("2", "MSFT"), trade("3", "TSLA")], catalog)!;
  assert.equal(result.methodology, "equal-weight-mapped-names");
  assert.deepEqual(result.constituents.map((c) => c.weightBps), [3334, 3333, 3333]);
});
test("gross buys and sales are activity, not netted holdings; repeated tickers combine and hashes are deterministic", () => {
  const rows = [trade("1", "AAPL"), { ...trade("2", "AAPL"), event: "Sale (Full)" }, trade("3", "MSFT")];
  const result = buildTradeIndex("P000197", rows, catalog)!;
  assert.deepEqual(result.constituents.map((c) => c.weightBps), [6667, 3333]);
  assert.equal(contentHash(result), contentHash(buildTradeIndex("P000197", [...rows].reverse(), catalog)));
});
test("a single mapped name is publishable; foreign persons, options and undated trades cannot supply it", () => {
  assert.equal(buildTradeIndex("P000197", [trade("1", "AAPL")], catalog)!.constituents[0].weightBps, 10000);
  assert.equal(buildTradeIndex("P000197", [{ ...trade("1", "AAPL"), personId: "WRONG" }], catalog), null);
  assert.equal(buildTradeIndex("P000197", [{ ...trade("1", "AAPL"), transactionDate: null }], catalog), null);
  assert.equal(buildTradeIndex("P000197", [], catalog), null);
});
