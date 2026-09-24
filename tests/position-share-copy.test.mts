import assert from "node:assert/strict";
import test from "node:test";
import { positionHoldingFigures } from "../src/lib/frontend/position-share-copy.ts";

test("USDC value leads and NAV shares read as a human count, not raw units", () => {
  const figures = positionHoldingFigures({ sharesRaw: "9975000", shareDecimals: 6, valueText: "$9.98" });
  assert.deepEqual(figures.map(figure => figure.role), ["value", "shares"]);
  assert.equal(figures[0].primary, true);
  assert.equal(figures[0].text, "$9.98");
  assert.equal(figures[0].label, "USDC value");
  assert.equal(figures[1].primary, false);
  assert.equal(figures[1].text, "9.975");
  assert.equal(figures[1].label, "shares");
  assert.doesNotMatch(`${figures[1].text} ${figures[1].label}`, /9,975,000|raw/);
});

test("unavailable USDC stays the main figure", () => {
  const figures = positionHoldingFigures({ sharesRaw: "20", shareDecimals: 6, valueText: "—" });
  assert.equal(figures[0].text, "—");
  assert.equal(figures[0].label, "value unavailable");
  assert.equal(figures[1].text, "0.00002");
});

test("human share counts keep integer precision and grouping", () => {
  const figures = positionHoldingFigures({ sharesRaw: "9007199254740993", shareDecimals: 6, valueText: "$1.00" });
  assert.equal(figures[1].text, "9,007,199,254.740993");
  assert.equal(positionHoldingFigures({ sharesRaw: "0", shareDecimals: 6, valueText: "$0.00" })[1].text, "0");
  assert.deepEqual(positionHoldingFigures({ sharesRaw: "1000000", shareDecimals: 6, valueText: "$1.00" }).map(figure => figure.text + " " + figure.label)[1], "1 share");
  assert.equal(positionHoldingFigures({ sharesRaw: "1000", shareDecimals: 0, valueText: "$2.00" })[1].text, "1,000");
});

test("invalid or unknown share details fall back to honestly labeled units", () => {
  const invalid = positionHoldingFigures({ sharesRaw: "1e6", shareDecimals: 6, valueText: "$1.00" });
  assert.equal(invalid[1].text, "—");
  assert.equal(invalid[1].label, "share units unavailable");
  const unknown = positionHoldingFigures({ sharesRaw: "20", valueText: "$1.00" });
  assert.equal(unknown[1].text, "20");
  assert.equal(unknown[1].label, "raw share units");
  assert.equal(positionHoldingFigures({ sharesRaw: "20", shareDecimals: 1.5, valueText: "$1.00" })[1].label, "raw share units");
});
