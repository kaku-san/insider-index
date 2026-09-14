import assert from "node:assert/strict";
import { test } from "node:test";
import { buildBook, summarizeWindow, tradeBand, type BookTrade } from "../src/lib/fomo/book.ts";

function ptr(over: Partial<BookTrade> & { id: string; ticker: string; side: BookTrade["side"]; transactionDate: string }): BookTrade {
  return {
    issuerName: over.ticker,
    kind: "politician",
    filedAt: `${over.transactionDate}T00:00:00.000Z`,
    transactionValue: over.amountLow != null && over.amountHigh != null ? (over.amountLow + over.amountHigh) / 2 : null,
    amountLow: null,
    amountHigh: null,
    sharesOwnedAfter: null,
    pricePerShare: null,
    ...over,
  };
}

test("buildBook keeps every disclosed ticker, tradable or not, and nets PTR bands", () => {
  const book = buildBook([
    ptr({ id: "a", ticker: "NVDA", side: "buy", transactionDate: "2026-01-10", amountLow: 1_000_000, amountHigh: 5_000_000 }),
    ptr({ id: "b", ticker: "NVDA", side: "sell", transactionDate: "2026-03-01", amountLow: 250_000, amountHigh: 500_000 }),
    ptr({ id: "c", ticker: "AVGO", side: "buy", transactionDate: "2026-02-02", amountLow: 500_000, amountHigh: 1_000_000 }),
    ptr({ id: "d", ticker: "PANW", side: "sell", transactionDate: "2026-02-20", amountLow: 15_000, amountHigh: 50_000 }),
  ]);
  const tickers = book.map((row) => row.ticker);
  assert.deepEqual(tickers, ["NVDA", "AVGO", "PANW"]);

  const nvda = book[0];
  assert.equal(nvda.status, "reduced");
  assert.equal(nvda.buys, 1);
  assert.equal(nvda.sells, 1);
  // low − sellHigh, high − sellLow
  assert.equal(nvda.valueLow, 500_000);
  assert.equal(nvda.valueHigh, 4_750_000);
  assert.equal(nvda.valueUsd, 2_625_000);
  assert.equal(nvda.lastSide, "sell");
  assert.equal(nvda.latestDisclosureId, "b");
  assert.equal(nvda.latestBuyDisclosureId, "a");

  const avgo = book[1];
  assert.equal(avgo.status, "holding");
  assert.equal(avgo.valueLow, 500_000);
  assert.equal(avgo.valueHigh, 1_000_000);

  // Sells with no earlier buy: they held it, size unknown — still listed.
  const panw = book[2];
  assert.equal(panw.status, "sold");
  assert.equal(panw.valueUsd, 0);
  assert.equal(panw.valueLow, null);
  assert.equal(panw.valueHigh, null);
});

test("buildBook marks a fully sold position as exited and floors at zero", () => {
  const [row] = buildBook([
    ptr({ id: "a", ticker: "TSLA", side: "buy", transactionDate: "2026-01-10", amountLow: 15_000, amountHigh: 50_000 }),
    ptr({ id: "b", ticker: "TSLA", side: "sell", transactionDate: "2026-02-10", amountLow: 50_000, amountHigh: 100_000 }),
  ]);
  assert.equal(row.status, "exited");
  assert.equal(row.valueLow, 0);
  assert.equal(row.valueHigh, 0);
  assert.equal(row.valueUsd, 0);
});

test("buildBook never fabricates a size when the source had none", () => {
  const [row] = buildBook([ptr({ id: "a", ticker: "AAPL", side: "buy", transactionDate: "2026-01-10" })]);
  assert.equal(row.status, "holding");
  assert.equal(row.valueLow, null);
  assert.equal(row.valueHigh, null);
  assert.equal(row.valueUsd, 0);
});

test("buildBook values an insider by the newest post-transaction holding", () => {
  const [row] = buildBook([
    { id: "old", ticker: "NVDA", issuerName: "NVIDIA", kind: "insider", side: "sell", transactionDate: "2026-01-05", filedAt: "2026-01-07T00:00:00Z", transactionValue: 1_000_000, amountLow: 1_000_000, amountHigh: 1_000_000, sharesOwnedAfter: 80_000, pricePerShare: 100 },
    { id: "new", ticker: "NVDA", issuerName: "NVIDIA", kind: "insider", side: "sell", transactionDate: "2026-03-05", filedAt: "2026-03-07T00:00:00Z", transactionValue: 2_000_000, amountLow: 2_000_000, amountHigh: 2_000_000, sharesOwnedAfter: 60_000, pricePerShare: 120 },
  ]);
  assert.equal(row.valueUsd, 7_200_000);
  assert.equal(row.status, "reduced");
  assert.equal(row.latestDisclosureId, "new");
});

test("buildBook falls back to a supplied price when the print carried none", () => {
  const [row] = buildBook(
    [{ id: "x", ticker: "MSFT", issuerName: "Microsoft", kind: "insider", side: "buy", transactionDate: "2026-03-05", filedAt: "2026-03-07T00:00:00Z", transactionValue: null, amountLow: null, amountHigh: null, sharesOwnedAfter: 10, pricePerShare: null }],
    { priceFor: () => 400 },
  );
  assert.equal(row.valueUsd, 4_000);
});

test("summarizeWindow sums bands and stays null with no sized trades", () => {
  const now = Date.parse("2026-03-10T00:00:00Z");
  const rows = [
    ptr({ id: "a", ticker: "NVDA", side: "buy", transactionDate: "2026-03-01", amountLow: 15_000, amountHigh: 50_000 }),
    ptr({ id: "b", ticker: "AVGO", side: "buy", transactionDate: "2026-03-02", amountLow: 1_000, amountHigh: 15_000 }),
    ptr({ id: "c", ticker: "OLD", side: "buy", transactionDate: "2025-01-01", amountLow: 1_000_000, amountHigh: 5_000_000 }),
  ];
  const window = summarizeWindow(rows, 30, now);
  assert.equal(window.trades, 2);
  assert.equal(window.volumeLow, 16_000);
  assert.equal(window.volumeHigh, 65_000);
  assert.equal(window.volumeUsd, 40_500);

  const empty = summarizeWindow([ptr({ id: "n", ticker: "X", side: "buy", transactionDate: "2026-03-05" })], 30, now);
  assert.equal(empty.trades, 1);
  assert.equal(empty.volumeUsd, null);
  assert.equal(empty.volumeLow, null);
});

test("tradeBand prefers the reported range over a point value", () => {
  assert.deepEqual(tradeBand({ amountLow: 1_000, amountHigh: 15_000, transactionValue: 8_000 }), { low: 1_000, high: 15_000 });
  assert.deepEqual(tradeBand({ amountLow: 50_000_000, amountHigh: null, transactionValue: null }), { low: 50_000_000, high: 50_000_000 });
  assert.deepEqual(tradeBand({ amountLow: null, amountHigh: null, transactionValue: 1234 }), { low: 1234, high: 1234 });
  assert.deepEqual(tradeBand({ amountLow: null, amountHigh: null, transactionValue: null }), { low: null, high: null });
});
