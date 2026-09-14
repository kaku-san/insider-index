import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MEGA_CAP_TICKERS,
  WIDE_CONGRESS_UNIVERSE,
  buildCongressUniverse,
  looksLikeUsTicker,
  parseTickerList,
  parseUniverseMode,
} from "../src/lib/disclosures/universe.ts";

test("the wide universe contains every mega-cap and no duplicates", () => {
  for (const ticker of MEGA_CAP_TICKERS) assert.ok(WIDE_CONGRESS_UNIVERSE.includes(ticker), ticker);
  assert.equal(new Set(WIDE_CONGRESS_UNIVERSE).size, WIDE_CONGRESS_UNIVERSE.length);
  assert.ok(WIDE_CONGRESS_UNIVERSE.length > 100);
});

test("parseTickerList normalises env overrides", () => {
  assert.deepEqual(parseTickerList(" nvda, aapl  msft,nvda"), ["AAPL", "MSFT", "NVDA"]);
  assert.deepEqual(parseTickerList(""), []);
  assert.deepEqual(parseTickerList(undefined), []);
});

test("parseUniverseMode defaults to catalog", () => {
  assert.equal(parseUniverseMode(undefined), "catalog");
  assert.equal(parseUniverseMode(" WIDE "), "wide");
  assert.equal(parseUniverseMode("full"), "full");
  assert.equal(parseUniverseMode("allowlist"), "catalog");
});

test("looksLikeUsTicker keeps US symbols and drops xStocks' invented HK/EU symbols", () => {
  for (const ok of ["A", "NVDA", "BRK.B", "PANW", "BE"]) assert.ok(looksLikeUsTicker(ok), ok);
  for (const no of ["BOCHK", "CITIC", "CKHUT", "nvda", "BRK.BB"]) assert.ok(!looksLikeUsTicker(no), no);
});

test("buildCongressUniverse widens by mode and honours an explicit list", () => {
  const catalog = { xstocks: ["NVDA", "VST", "BOCHK", "CITIC", "GME"], backpack: ["NVDA", "TEM", "CITIC"] };
  const wide = buildCongressUniverse("wide", catalog);
  assert.deepEqual(wide, [...WIDE_CONGRESS_UNIVERSE]);

  const byCatalog = buildCongressUniverse("catalog", catalog);
  assert.ok(byCatalog.includes("VST") && byCatalog.includes("GME"), "US-looking xStock underlyings join");
  assert.ok(byCatalog.includes("CITIC"), "an xStock that Backpack also lists as .US is US-listed");
  assert.ok(!byCatalog.includes("BOCHK"), "xStock-only 5-letter symbols are not US tickers");
  assert.ok(!byCatalog.includes("TEM"), "Backpack-only names need mode=full");

  const full = buildCongressUniverse("full", catalog);
  assert.ok(full.includes("TEM"));
  assert.deepEqual(full, [...full].sort());

  assert.deepEqual(buildCongressUniverse("full", catalog, ["nvda", "AAPL", "NVDA"].map((t) => t.toUpperCase())), ["AAPL", "NVDA"]);
});
