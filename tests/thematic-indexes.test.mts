import assert from "node:assert/strict";
import test from "node:test";
import { listThematicIndexes, isThematicIndex } from "../src/lib/fomo/thematic-indexes.ts";
import { getThematicView, listThematicViews, thematicDirectory } from "../src/lib/thematic/views.ts";
import { indexReadiness } from "../src/lib/fomo/index-readiness.ts";

test("thematic live feed exposes 10 PersonIndex baskets with unit weights", () => {
  const indexes = listThematicIndexes();
  assert.equal(indexes.length, 10);
  for (const index of indexes) {
    assert.ok(isThematicIndex(index));
    assert.ok(index.constituents.length >= 3);
    const sum = index.constituents.reduce((n, c) => n + c.weightPct, 0);
    assert.ok(Math.abs(sum - 1) < 1e-4, `${index.id} weightPct=${sum}`);
    for (const c of index.constituents) {
      assert.ok(c.mint);
      assert.ok(c.venue === "xstock" || c.venue === "backpack");
      assert.ok(Number.isInteger(c.mintDecimals));
    }
    const ready = indexReadiness(index, []);
    assert.equal(ready.shape, "thematic");
    assert.equal(ready.ready, true);
  }
});

test("thematic views expose exact 10000 bps and website narrative", () => {
  const views = listThematicViews();
  assert.equal(views.length, 10);
  const mag7 = getThematicView("mag7-caucus");
  assert.ok(mag7);
  assert.equal(mag7.indexName, "Mag7 Caucus");
  assert.equal(mag7.constituents.reduce((n, c) => n + c.weight_bps, 0), 10_000);
  assert.match(mag7.narrative, /mega-cap/i);
  assert.ok(!/Pelorian|Green Machine/i.test(JSON.stringify(views.map((v) => v.indexName))));
  const dir = thematicDirectory();
  assert.equal(dir.count, 10);
  assert.ok(dir.sources.websiteFooterBlock.length >= 5);
});
