import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { indexCatalog, type CatalogToken } from "../src/lib/venues/catalog-parse.ts";
import { MAINNET_USDC_MINT, MIN_RAYDIUM_POOL_TVL_USD, mainnetRaydiumPoolSnapshot, poolReadiness, RAYDIUM_CLMM_PROGRAM, RAYDIUM_CPMM_PROGRAM, type MainnetRaydiumPool } from "../src/lib/index-vaults/raydium-pools-mainnet.ts";
import { buildTrackerIndex, renormalizeBps, trackerIndexId } from "../src/lib/tracker/tracker-index.ts";
import { normalizeTrackerHandoff, type TrackerProfile } from "../src/lib/tracker/tracker-parse.ts";
import { buildShownBook, compareWithFmp } from "../src/lib/tracker/shown-book.ts";
import { buildTrackerPersonView, trackerIndexPerson } from "../src/lib/tracker/views.ts";
import { baseIndexName } from "../src/lib/fmp/index-name.ts";

const brief = JSON.parse(readFileSync(new URL("../data/insiderindex-source-buckets/pelositracker-top20-handoff/top20-agent-brief.json", import.meta.url), "utf8"));
const handoff = normalizeTrackerHandoff(brief);
const pelosi = handoff.profiles[0];
const catalogSnapshot = JSON.parse(readFileSync(new URL("../src/lib/venues/catalog-snapshot.json", import.meta.url), "utf8")) as { xstocks: CatalogToken[]; backpack: CatalogToken[] };
const catalog = indexCatalog([...catalogSnapshot.xstocks, ...catalogSnapshot.backpack]);
const pools = mainnetRaydiumPoolSnapshot();

const token = (ticker: string, issuer: "xstock" | "backpack" = "xstock"): CatalogToken => ({ issuer, ticker, symbol: issuer === "xstock" ? `${ticker}x` : `${ticker}.US`, name: ticker, mint: `${ticker}mint`.padEnd(32, "1"), decimals: 8 });
const pool = (mint: string, tvlUsd: number): MainnetRaydiumPool => ({ mint, symbol: null, pool: `${mint}pool`, kind: "raydium_clmm", programId: RAYDIUM_CLMM_PROGRAM, quoteMint: MAINNET_USDC_MINT, tvlUsd, dayVolumeUsd: null, observedAt: "2026-09-15T14:52:20.715Z" });
function profile(holdings: { ticker: string; percentage: number | null; value?: number | null }[], id = "T000001"): TrackerProfile {
  return {
    ...pelosi, id, slug: "test", name: "Test Person", topHoldings: holdings.map((h, i) => ({ ordinal: i, ticker: h.ticker, name: h.ticker, valueUsd: h.value ?? null, percentage: h.percentage })),
    recentTrades: [{ ordinal: 0, date: "2026-09-01", dateLabel: "2026-09-01", ticker: "TRADEONLY", side: "buy", sourceType: "Buy", amountEstimateUsd: 15000000.5, amountBand: { low: 5000001, high: 25000000 }, filingStatus: "New", notificationDate: null, flags: [] }],
  };
}

test("the committed Raydium snapshot is mainnet-USDC CLMM/CPMM only and never a Pyth account", () => {
  assert.equal(pools.quoteMint, MAINNET_USDC_MINT);
  assert.ok(pools.pools.length > 0);
  for (const entry of pools.pools) {
    assert.equal(entry.quoteMint, MAINNET_USDC_MINT);
    assert.ok([RAYDIUM_CLMM_PROGRAM, RAYDIUM_CPMM_PROGRAM].includes(entry.programId));
    assert.ok(entry.kind === "raydium_clmm" || entry.kind === "raydium_cpmm");
    assert.ok(entry.tvlUsd > 0);
    assert.match(entry.pool, /^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
  }
  assert.equal(new Set(pools.pools.map((p) => p.mint)).size, pools.pools.length);
  assert.equal(poolReadiness("nonexistent").status, "none");
  assert.equal(poolReadiness("Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh").status, "observed", "NVDAx has an observed USDC pool");
  const thin = pools.pools.find((p) => p.tvlUsd < MIN_RAYDIUM_POOL_TVL_USD);
  if (thin) assert.equal(poolReadiness(thin.mint).status, "thin");
});

test("renormalizeBps sums to exactly 10,000 with a one-bp floor", () => {
  assert.deepEqual(renormalizeBps([43.49, 7.67, 6.97, 6.9]), [6688, 1179, 1072, 1061]);
  assert.equal(renormalizeBps([43.49, 7.67, 6.97, 6.9]).reduce((a, b) => a + b, 0), 10_000);
  assert.deepEqual(renormalizeBps([1, 1, 1]), [3334, 3333, 3333]);
  assert.deepEqual(renormalizeBps([99.999, 0.0001]), [9999, 1]);
  assert.deepEqual(renormalizeBps([]), []);
  assert.throws(() => renormalizeBps([1, 0]), /positive-scores-required/);
});

test("Pelosi's tracker index is the investable slice of her shown positions: mint + Raydium pool, 10,000 bps, first live candidate", () => {
  const index = buildTrackerIndex(pelosi, baseIndexName(trackerIndexPerson(pelosi)), catalog, pools.pools);
  assert.equal(index.id, "tracker-P000197");
  assert.equal(index.indexName, "Nancy P Index · Tracker positions");
  assert.equal(index.basis, "pelositracker-positions");
  assert.equal(index.asOf, "2026-09-15");
  assert.deepEqual(index.constituents.map((c) => [c.ticker, c.weightBps, c.token.symbol]), [["NVDA", 6688, "NVDAx"], ["AMZN", 1179, "AMZNx"], ["MSFT", 1072, "MSFTx"], ["AVGO", 1061, "AVGOx"]]);
  assert.equal(index.constituents.reduce((sum, c) => sum + c.weightBps, 0), 10_000);
  for (const c of index.constituents) { assert.equal(c.pool.quoteMint, MAINNET_USDC_MINT); assert.ok(c.pool.tvlUsd >= MIN_RAYDIUM_POOL_TVL_USD); assert.equal(c.pool.mint, c.token.mint); }
  assert.deepEqual(index.excluded.map((e) => [e.ticker, e.reason]), [["GOOG", "no-raydium-usdc-pool"]]);
  assert.equal(index.readiness.status, "VAULT_CANDIDATE");
  assert.equal(index.readiness.firstLiveCandidate, true);
  assert.equal(index.readiness.fundsEnabled, false);
  assert.equal(index.tradesUsed, false);
  assert.equal(index.coverage.includedTrackerPercentage, 65.03);
  assert.equal(index.coverage.listedTrackerPercentage, 70.03);
  assert.match(index.navDisclaimer, /not this index's NAV/);
  assert.ok(index.readiness.reasons.some((reason) => /exit is USDC only \(no in-kind xStock redemption\)/.test(reason)));
  // The tracker's $315M total and share counts are nowhere in the weights.
  assert.ok(!JSON.stringify(index.constituents.map((c) => c.weightBps)).includes("314903941"));
});

test("names without a mint, without a pool, or with a thin pool are listed as excluded; trades never enter; other people wait", () => {
  const cat = indexCatalog([token("AAA"), token("BBB"), token("THIN"), token("DUP", "backpack")]);
  const p = profile([{ ticker: "AAA", percentage: 30 }, { ticker: "BBB", percentage: 10 }, { ticker: "NOMINT", percentage: 20 }, { ticker: "THIN", percentage: 5 }, { ticker: "DUP", percentage: 1 }]);
  const testPools = [pool(token("AAA").mint, 500_000), pool(token("THIN").mint, 5), pool(token("DUP", "backpack").mint, 50_000)];
  const index = buildTrackerIndex(p, "Test P Index", cat, testPools);
  assert.deepEqual(index.constituents.map((c) => [c.ticker, c.weightBps]), [["AAA", 9677], ["DUP", 323]]);
  assert.deepEqual(index.excluded.map((e) => [e.ticker, e.reason]), [["BBB", "no-raydium-usdc-pool"], ["NOMINT", "no-solana-mint"], ["THIN", "raydium-pool-thin"]]);
  assert.equal(index.readiness.status, "VAULT_CANDIDATE");
  assert.equal(index.readiness.firstLiveCandidate, false);
  assert.ok(!index.constituents.some((c) => c.ticker === "TRADEONLY"), "the trade tape is not an input");
  const single = buildTrackerIndex(profile([{ ticker: "AAA", percentage: 30 }, { ticker: "NOMINT", percentage: 20 }]), "Test P Index", cat, testPools);
  assert.equal(single.readiness.status, "WAIT_READINESS");
  assert.deepEqual(single.constituents.map((c) => c.weightBps), [10_000]);
  const none = buildTrackerIndex(profile([{ ticker: "NOMINT", percentage: 20 }]), "Test P Index", cat, testPools);
  assert.equal(none.constituents.length, 0);
  assert.equal(none.readiness.status, "WAIT_READINESS");
  assert.match(none.readiness.reasons[0], /no tracker position has both/);
  const unsized = buildTrackerIndex(profile([{ ticker: "AAA", percentage: null }, { ticker: "DUP", percentage: 2 }]), "Test P Index", cat, testPools);
  assert.deepEqual(unsized.excluded.map((e) => e.reason), ["no-tracker-percentage"]);
});

test("all 20 handoff people get a listed tracker index; only those with two pooled names are candidates", () => {
  const views = handoff.profiles.map((p) => buildTrackerPersonView(p, { ...catalog, feeds: [] }));
  assert.equal(views.length, 20);
  for (const view of views) {
    assert.equal(view.index.id, trackerIndexId(view.profile.id));
    assert.match(view.index.indexName, / Index · Tracker positions$/);
    const listed = new Set([...view.index.constituents.map((c) => c.ticker), ...view.index.excluded.map((e) => e.ticker)]);
    assert.ok(view.profile.topHoldings.every((h) => listed.has(h.ticker)), "every tracker position is either a constituent or an explained exclusion");
    if (view.index.constituents.length) assert.equal(view.index.constituents.reduce((s, c) => s + c.weightBps, 0), 10_000);
    assert.equal(view.index.readiness.status, view.index.constituents.length >= 2 ? "VAULT_CANDIDATE" : "WAIT_READINESS");
    assert.equal(view.index.readiness.firstLiveCandidate, view.profile.id === "P000197");
    assert.equal(view.release.publicFundsEnabled, false);
    assert.equal(view.holdingTokens.length, view.profile.topHoldings.length);
  }
  assert.equal(views.filter((v) => v.index.readiness.firstLiveCandidate).length, 1);
  assert.equal(trackerIndexPerson(handoff.profiles.find((p) => p.id === "C001123")!).lastName, "Cisneros");
  assert.equal(trackerIndexPerson(handoff.profiles.find((p) => p.id === "K000383")!).lastName, "King");
  assert.equal(buildTrackerPersonView(handoff.profiles.find((p) => p.id === "S001217")!, { ...catalog, feeds: [] }, "Richard S Index").index.indexName, "Richard S Index · Tracker positions", "the saved canonical FMP index name wins");
});

test("the shown book puts tracker positions first, appends older annual rows and never sums the two", () => {
  const annual = { referenceDate: "2024-12-31", items: [
    { id: "a1", name: "NVIDIA Corporation - Common Stock (NVDA) [ST]", ticker: null, kind: "stock", owner: "Spouse", valueRange: { low: 5000001, high: 25000000 } },
    { id: "a2", name: "Alphabet Inc. - Class A (GOOGL) [ST]", ticker: null, kind: "stock", owner: "Spouse", valueRange: { low: 5000001, high: 25000000 } },
    { id: "a3", name: "Union Bank of California", ticker: null, kind: "liability", owner: "Joint", valueRange: { low: 1000001, high: 5000000 } },
    { id: "a4", name: "Broadcom Inc. - Common Stock (AVGO) [OP]", ticker: null, kind: "option", owner: "Spouse", valueRange: { low: 1000001, high: 5000000 } },
  ] };
  const resolutions = new Map([["a1", { holding: { id: "a1" }, ticker: "NVDA", token: { issuer: "xstock", symbol: "NVDAx", mint: "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh" } }]]);
  const book = buildShownBook(pelosi, annual, resolutions);
  assert.equal(book.asOf, "2026-09-15");
  assert.equal(book.fmpReferenceDate, "2024-12-31");
  assert.deepEqual(book.rows.slice(0, 5).map((r) => [r.ticker, r.source]), [["NVDA", "both"], ["AMZN", "tracker"], ["MSFT", "tracker"], ["AVGO", "both"], ["GOOG", "tracker"]]);
  assert.equal(book.rows[0].tracker?.percentage, 43.49);
  assert.equal(book.rows[0].tracker?.valueUsd, 136951952);
  assert.deepEqual(book.rows[0].fmp?.rows[0].valueRange, { low: 5000001, high: 25000000 });
  assert.equal(book.rows[0].token?.symbol, "NVDAx");
  assert.equal(book.rows[3].fmp?.rows[0].kind, "option", "AVGO stock on the tracker sits beside the AVGO option on the filing; classes stay visible");
  const annualOnly = book.rows.slice(5);
  assert.deepEqual(annualOnly.map((r) => [r.ticker, r.source]), [["GOOGL", "fmp-annual"], [null, "fmp-annual"]]);
  assert.equal(annualOnly[1].name, "Union Bank of California");
  assert.deepEqual(book.counts, { tracker: 5, fmpAnnual: 4, both: 2 });
  assert.match(book.note, /never added together/);
  assert.ok(!("total" in book) && !("totalUsd" in book));
  const noFmp = buildShownBook(pelosi, null);
  assert.equal(noFmp.rows.length, 5);
  assert.match(noFmp.note, /No saved FMP annual book/);
});

test("the FMP comparison shows both sides by exact ticker and reports overlap without overwriting either", () => {
  const published = { period: "2024-12-31", constituents: [{ ticker: "NVDA", mint: "m1", issuer: "xstock", weight_bps: 1553 }, { ticker: "AAPL", mint: "m2", issuer: "xstock", weight_bps: 3881 }, { ticker: "GOOGL", mint: "m3", issuer: "xstock", weight_bps: 1553 }] };
  const annual = { referenceDate: "2024-12-31", items: [{ id: "a1", name: "NVIDIA Corporation (NVDA) [ST]", ticker: null, kind: "stock", owner: null, valueRange: { low: 5000001, high: 25000000 } }] };
  const comparison = compareWithFmp(pelosi, published, annual);
  assert.equal(comparison.fmpPublished, true);
  assert.equal(comparison.fmpPeriod, "2024-12-31");
  assert.deepEqual(comparison.rows.map((r) => [r.ticker, r.presence, r.trackerPercentage, r.fmpWeightBps]), [
    ["NVDA", "both", 43.49, 1553], ["AMZN", "tracker-only", 7.67, null], ["MSFT", "tracker-only", 6.97, null], ["AVGO", "tracker-only", 6.9, null], ["GOOG", "tracker-only", 5, null],
    ["AAPL", "fmp-only", null, 3881], ["GOOGL", "fmp-only", null, 1553],
  ]);
  assert.deepEqual(comparison.rows[0].fmpAnnualBand, { low: 5000001, high: 25000000 });
  assert.deepEqual(comparison.overlap, { tickers: ["NVDA"], trackerOnly: ["AMZN", "MSFT", "AVGO", "GOOG"], fmpOnly: ["AAPL", "GOOGL"] });
  const none = compareWithFmp(pelosi, null, null);
  assert.equal(none.fmpPublished, false);
  assert.equal(none.rows.length, 5);
  assert.match(none.note, /No saved FMP annual book or published FMP index/);
});
