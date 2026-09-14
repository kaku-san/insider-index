import assert from "node:assert/strict";
import { test } from "node:test";
import {
  backpackTickerFromBase,
  backpackTradeUrl,
  indexBackpackListings,
  parseBackpackMarkets,
} from "../src/lib/venues/backpack-parse.ts";

const rows = [
  { symbol: "SOL_USDC", baseSymbol: "SOL", quoteSymbol: "USDC", marketType: "SPOT", rwaMarketType: null, orderBookState: "Open", visible: true },
  { symbol: "MU.US_USDC", baseSymbol: "MU.US", quoteSymbol: "USDC", marketType: "SPOT", rwaMarketType: "STOCK", orderBookState: "Open", visible: true },
  { symbol: "MU.US_USDC_PERP", baseSymbol: "MU.US", quoteSymbol: "USDC", marketType: "PERP", rwaMarketType: "STOCK", orderBookState: "Open", visible: true },
  { symbol: "NVDA.US_USDC_PERP", baseSymbol: "NVDA.US", quoteSymbol: "USDC", marketType: "PERP", rwaMarketType: "STOCK", orderBookState: "Open", visible: true },
  { symbol: "AMZN.US_USDC_PERP", baseSymbol: "AMZN.US", quoteSymbol: "USDC", marketType: "PERP", rwaMarketType: "STOCK", orderBookState: "PostOnly", visible: false },
  { symbol: "SPY.US_USDC_PERP", baseSymbol: "SPY.US", quoteSymbol: "USDC", marketType: "PERP", rwaMarketType: "INDEX", orderBookState: "Open", visible: true },
];

test("parseBackpackMarkets keeps only open, visible RWA markets", () => {
  const listings = parseBackpackMarkets(rows);
  assert.deepEqual(listings.map((row) => row.symbol), ["MU.US_USDC", "MU.US_USDC_PERP", "NVDA.US_USDC_PERP", "SPY.US_USDC_PERP"]);
  assert.equal(listings[0].market, "spot");
  assert.equal(listings[2].market, "perp");
  assert.equal(listings[2].ticker, "NVDA");
  assert.deepEqual(parseBackpackMarkets(null), []);
  assert.deepEqual(parseBackpackMarkets([{}]), []);
});

test("indexBackpackListings prefers spot over perp per ticker", () => {
  const byTicker = indexBackpackListings(parseBackpackMarkets(rows));
  assert.equal(byTicker.get("MU")?.symbol, "MU.US_USDC");
  assert.equal(byTicker.get("NVDA")?.symbol, "NVDA.US_USDC_PERP");
  assert.equal(byTicker.has("AMZN"), false);
  assert.equal(byTicker.has("SOL"), false);
});

test("backpack helpers", () => {
  assert.equal(backpackTickerFromBase("NVDA.US"), "NVDA");
  assert.equal(backpackTickerFromBase("BRK.B.US"), "BRK.B");
  assert.equal(backpackTickerFromBase("SOL"), null);
  assert.equal(backpackTradeUrl("NVDA.US_USDC_PERP"), "https://backpack.exchange/trade/NVDA.US_USDC_PERP");
});
