import assert from "node:assert/strict";
import test from "node:test";
import { positionHoldingFigures } from "../src/lib/frontend/position-share-copy.ts";
import { formatVaultShares } from "../src/lib/index-vaults/positions-contract.ts";

test("20 raw Mag7 units are not shown as 0.00002", () => {
  assert.equal(formatVaultShares("20", 6), "0.00002");
  const figures = positionHoldingFigures({ sharesRaw: "20", shareDecimals: 6, valueText: "$4.10" });
  assert.deepEqual(figures.map(figure => figure.role), ["value", "shares"]);
  assert.equal(figures[0].primary, true);
  assert.equal(figures[0].text, "$4.10");
  assert.equal(figures[0].label, "USDC value");
  assert.equal(figures[1].primary, false);
  assert.equal(figures[1].text, "20");
  assert.equal(figures[1].label, "raw share units · 6 decimals");
  assert.notEqual(figures[1].text, "0.00002");
  assert.doesNotMatch(`${figures[0].text} ${figures[1].text} ${figures[1].label}`, /0\.00002/);
});

test("unavailable USDC stays the main number instead of a decimal share count", () => {
  const figures = positionHoldingFigures({ sharesRaw: "20", shareDecimals: 6, valueText: "—" });
  assert.equal(figures[0].text, "—");
  assert.equal(figures[0].label, "value unavailable");
  assert.equal(figures[1].text, "20");
  assert.notEqual(figures[0].text, formatVaultShares("20", 6));
});

test("raw share units keep integer precision and grouping", () => {
  const figures = positionHoldingFigures({ sharesRaw: "9007199254740993", shareDecimals: 6, valueText: "$1.00" });
  assert.equal(figures[1].text, "9,007,199,254,740,993");
  assert.equal(positionHoldingFigures({ sharesRaw: "0", shareDecimals: 6, valueText: "$0.00" })[1].text, "0");
  assert.equal(positionHoldingFigures({ sharesRaw: "1000", shareDecimals: 0, valueText: "$2.00" })[1].label, "raw share units · 0 decimals");
});

test("invalid or unknown share details are not presented as a price", () => {
  const invalid = positionHoldingFigures({ sharesRaw: "1e6", shareDecimals: 6, valueText: "$1.00" });
  assert.equal(invalid[1].text, "—");
  assert.equal(invalid[1].label, "share units unavailable");
  const unknown = positionHoldingFigures({ sharesRaw: "20", valueText: "$1.00" });
  assert.equal(unknown[1].text, "20");
  assert.equal(unknown[1].label, "raw share units");
  assert.doesNotMatch(unknown[1].label, /decimals/);
  assert.equal(positionHoldingFigures({ sharesRaw: "20", shareDecimals: 1.5, valueText: "$1.00" })[1].label, "raw share units");
});
