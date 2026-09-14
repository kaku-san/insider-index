import assert from "node:assert/strict";
import { test } from "node:test";
import { WIDE_CONGRESS_UNIVERSE, XSTOCK_UNDERLYINGS, parseTickerList } from "../src/lib/disclosures/universe.ts";
import { XSTOCK_ALLOWLIST } from "../src/lib/allowlist.ts";

test("the wide universe contains every xStock underlying and no duplicates", () => {
  const allowlisted = [...new Set(XSTOCK_ALLOWLIST.flatMap((item) => [...item.underlyingTickers]))].sort();
  assert.deepEqual([...XSTOCK_UNDERLYINGS].sort(), allowlisted);
  for (const ticker of allowlisted) assert.ok(WIDE_CONGRESS_UNIVERSE.includes(ticker), ticker);
  assert.equal(new Set(WIDE_CONGRESS_UNIVERSE).size, WIDE_CONGRESS_UNIVERSE.length);
  assert.ok(WIDE_CONGRESS_UNIVERSE.length > 100);
});

test("parseTickerList normalises env overrides", () => {
  assert.deepEqual(parseTickerList(" nvda, aapl  msft,nvda"), ["AAPL", "MSFT", "NVDA"]);
  assert.deepEqual(parseTickerList(""), []);
  assert.deepEqual(parseTickerList(undefined), []);
});
