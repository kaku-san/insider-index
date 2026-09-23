import test from "node:test";
import assert from "node:assert/strict";
import { renormalize, slice, tradable, exclusionReason } from "../scripts/nav-vault-slices.mts";
import { tradableSliceFor, tradableSliceLabel } from "../src/lib/nav-vault/slices.ts";

const liquid = { small: true, p10: 100, p100: 100.5, driftPct: 0.5 };
test("tradable slice keeps liquid legs, renormalizes disclosed weights to 10,000 and records every excluded name with a reason", () => {
  assert.equal(tradable(liquid), true);
  assert.equal(tradable({ ...liquid, driftPct: 2.4 }), false);
  assert.equal(tradable({ ...liquid, small: false }), false);
  assert.equal(exclusionReason(undefined), "not scanned");
  assert.equal(exclusionReason({ small: false, p10: null, p100: null, driftPct: null }), "no Jupiter or Raydium route");
  assert.match(exclusionReason({ ...liquid, driftPct: 55.2 }), /price moves 55\.2% between a \$10 and a \$100 buy/);
  assert.deepEqual(renormalize([4000, 2000, 1000]), [5714, 2857, 1429]);
  assert.equal(renormalize([3333, 3333, 3334]).reduce((a, b) => a + b, 0), 10_000);
  const def = { indexId: "x", kind: "person", name: "X", legs: [
    { ticker: "A", mint: "a", decimals: 8, targetWeightBps: 5000 },
    { ticker: "B", mint: "b", decimals: 8, targetWeightBps: 3000 },
    { ticker: "C", mint: "c", decimals: 8, targetWeightBps: 1500 },
    { ticker: "D", mint: "d", decimals: 8, targetWeightBps: 500 },
  ] };
  const out = slice(def, { a: liquid, c: liquid, d: liquid, b: { small: true, p10: 10, p100: 20, driftPct: 100 } });
  assert.equal(out.tradableLegs, 3);
  assert.equal(out.disclosedWeightBps, 7000);
  assert.equal(out.eligible, true);
  assert.deepEqual(out.vaultLegs.map(l => [l.ticker, l.targetWeightBps]), [["A", 7143], ["C", 2143], ["D", 714]]);
  assert.deepEqual(out.excluded.map(e => e.ticker), ["B"]);
  const thin = slice({ ...def, legs: def.legs.slice(0, 2) }, { a: liquid });
  assert.equal(thin.eligible, false, "under 3 legs stays research only");
});

test("committed slices: Pelosi is in the vault set with an honest label; Mag7 holds its full book", () => {
  const pelosi = tradableSliceFor("insiderindex-nancy-pelosi");
  assert.ok(pelosi && pelosi.eligible);
  assert.equal(pelosi.vaultLegs.reduce((s, l) => s + l.targetWeightBps, 0), 10_000);
  assert.equal(pelosi.tradableLegs + pelosi.excluded.length, pelosi.totalLegs, "every disclosed name is either held or listed as excluded");
  assert.match(tradableSliceLabel(pelosi), /^Tradable slice: \d+ of 18 holdings \(\d+\.\d% of disclosed weight\)$/);
  const mag7 = tradableSliceFor("idx-theme-mag7-caucus")!;
  assert.equal(tradableSliceLabel(mag7), "Tradable slice: 7 of 7 holdings (100.0% of disclosed weight)");
});
