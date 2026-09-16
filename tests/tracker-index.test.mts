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

const brief = JSON.parse(readFileSync(new URL("../data/insiderindex-source-buckets/pelositracker-top20rere-handoff/top20-agent-brief.json", import.meta.url), "utf8"));
const handoff = normalizeTrackerHandoff(brief);
const pelosi = handoff.profiles[0];
const catalogSnapshot = JSON.parse(readFileSync(new URL("../src/lib/venues/catalog-snapshot.json", import.meta.url), "utf8")) as { xstocks: CatalogToken[]; backpack: CatalogToken[] };
const catalog = indexCatalog([...catalogSnapshot.xstocks, ...catalogSnapshot.backpack]);
const pools = mainnetRaydiumPoolSnapshot();

const token = (ticker: string, issuer: "xstock" | "backpack" = "xstock"): CatalogToken => ({ issuer, ticker, symbol: issuer === "xstock" ? `${ticker}x` : `${ticker}.US`, name: ticker, mint: `${ticker}${issuer === "backpack" ? "b" : ""}mint`.padEnd(32, "1"), decimals: 8 });
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

test("Pelosi's tracker index is the investable slice of her copy-trade book: xStock preferred, Backpack otherwise, 10,000 bps, first live candidate", () => {
  assert.equal(pelosi.holdingsBasis, "copy-trade-full");
  assert.equal(pelosi.topHoldings.length, 15);
  const index = buildTrackerIndex(pelosi, baseIndexName(trackerIndexPerson(pelosi)), catalog, pools.pools);
  assert.equal(index.id, "tracker-P000197");
  assert.equal(index.indexName, "Nancy P Index · Tracker positions");
  assert.equal(index.basis, "pelositracker-positions");
  assert.equal(index.asOf, "2026-09-15");
  assert.equal(index.tradesUsed, false);
  assert.equal(index.readiness.firstLiveCandidate, true);
  assert.equal(index.readiness.fundsEnabled, false);
  assert.match(index.navDisclaimer, /three different figures|not this index's NAV/);
  assert.ok(index.readiness.reasons.some((reason) => /exit is USDC only \(no in-kind xStock redemption\)/.test(reason)));
  const listed = new Set([...index.constituents.map((c) => c.ticker), ...index.excluded.map((e) => e.ticker)]);
  assert.ok(pelosi.topHoldings.every((h) => listed.has(h.ticker)));
  assert.deepEqual(index.excluded.find((e) => e.ticker === "IBTA.L")?.reason, "no-solana-mint");
  if (index.constituents.length) assert.equal(index.constituents.reduce((sum, c) => sum + c.weightBps, 0), 10_000);
  assert.equal(index.readiness.status, index.constituents.length >= 2 ? "VAULT_CANDIDATE" : "WAIT_READINESS");
  for (const c of index.constituents) {
    assert.ok(c.token.issuer === "xstock" || c.token.issuer === "backpack");
    assert.equal(c.pool.quoteMint, MAINNET_USDC_MINT);
    assert.ok(c.pool.tvlUsd >= MIN_RAYDIUM_POOL_TVL_USD);
    assert.equal(c.pool.mint, c.token.mint);
    if (c.ticker === "VST" || c.ticker === "TEM") assert.equal(c.token.issuer, "backpack", "no xStock: use verified Backpack .US");
    if (c.ticker === "AAPL" || c.ticker === "NVDA") assert.equal(c.token.issuer, "xstock", "xStock preferred when both exist");
  }
  const payload = JSON.stringify(index);
  assert.ok(!payload.includes("314903941"));
  assert.ok(!payload.includes("23202729"));
  assert.ok(!/"quantity"/.test(JSON.stringify(index.constituents)));
});

test("copy-trade weights renormalize over mint+pool names; backpack fills in when there is no xStock; quantities never enter", () => {
  const cat = indexCatalog([
    token("NVDA"), token("GOOGL"), token("BE"), token("AVGO"),
    token("VST", "backpack"), token("VST"), // xStock wins when both exist
    token("TEM", "backpack"),
  ]);
  const testPools = ["NVDA", "GOOGL", "BE", "AVGO", "VST", "TEM"].map((ticker) => pool((ticker === "VST" || ticker === "TEM" ? token(ticker, "backpack") : token(ticker)).mint, 50_000));
  // Duplicate VST xStock mint has no pool — preferredToken is xStock first, so VST is excluded without falling through to Backpack.
  const withBoth = buildTrackerIndex(profile([{ ticker: "NVDA", percentage: 50 }, { ticker: "VST", percentage: 50 }], "P000197"), "Nancy P Index", cat, [pool(token("NVDA").mint, 50_000), pool(token("VST", "backpack").mint, 50_000)]);
  assert.equal(withBoth.constituents[0].token.issuer, "xstock");
  assert.equal(withBoth.excluded.find((e) => e.ticker === "VST")?.reason, "no-raydium-usdc-pool", "do not invent a Backpack fallback when an xStock mint exists");
  const backpackOnly = buildTrackerIndex(profile([{ ticker: "TEM", percentage: 40 }, { ticker: "NVDA", percentage: 60 }]), "Test P Index", cat, testPools);
  assert.deepEqual(backpackOnly.constituents.map((c) => [c.ticker, c.token.issuer, c.token.symbol]), [["NVDA", "xstock", "NVDAx"], ["TEM", "backpack", "TEM.US"]]);
  assert.equal(backpackOnly.constituents.reduce((s, c) => s + c.weightBps, 0), 10_000);
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

test("the shown book puts copy-trade positions first for Pelosi, appends older annual rows and never sums the two", () => {
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
  assert.deepEqual(book.rows.slice(0, 5).map((r) => r.ticker), ["NVDA", "GOOGL", "BE", "AVGO", "PANW"]);
  assert.equal(book.rows[0].source, "both");
  assert.equal(book.rows[0].tracker?.percentage, 15.16);
  assert.equal(book.rows.find((r) => r.ticker === "GOOGL")?.source, "both");
  assert.equal(book.rows.find((r) => r.ticker === "AVGO")?.fmp?.rows[0].kind, "option", "AVGO stock on the tracker sits beside the AVGO option on the filing; classes stay visible");
  assert.equal(book.rows.find((r) => r.name === "Union Bank of California")?.source, "fmp-annual");
  assert.ok(!book.rows.some((r) => r.key === "tracker:OTHER"), "copy-trade book does not invent OTHER tickers or mix in the disclosure aggregate");
  assert.equal(book.counts.tracker, 15);
  assert.match(book.note, /never added together/);
  assert.match(book.note, /copy-trade/);
  assert.ok(!("total" in book) && !("totalUsd" in book));
  const noFmp = buildShownBook(pelosi, null);
  assert.equal(noFmp.rows.length, 15);
  assert.match(noFmp.note, /No saved FMP annual book/);
  const scott = handoff.profiles.find((p) => p.id === "S001217")!;
  const sliceBook = buildShownBook(scott, null);
  assert.equal(scott.holdingsBasis, "disclosure-slice");
  assert.equal(sliceBook.rows.filter((r) => r.ticker).length, 5);
  const other = sliceBook.rows.find((r) => r.key === "tracker:OTHER");
  assert.ok(other && other.ticker === null);
  assert.match(other!.name ?? "", /OTHER/i);
});

test("the FMP comparison shows both sides by exact ticker and reports overlap without overwriting either", () => {
  const published = { period: "2024-12-31", constituents: [{ ticker: "NVDA", mint: "m1", issuer: "xstock", weight_bps: 1553 }, { ticker: "AAPL", mint: "m2", issuer: "xstock", weight_bps: 3881 }, { ticker: "GOOGL", mint: "m3", issuer: "xstock", weight_bps: 1553 }] };
  const annual = { referenceDate: "2024-12-31", items: [{ id: "a1", name: "NVIDIA Corporation (NVDA) [ST]", ticker: null, kind: "stock", owner: null, valueRange: { low: 5000001, high: 25000000 } }] };
  const comparison = compareWithFmp(pelosi, published, annual);
  assert.equal(comparison.fmpPublished, true);
  assert.equal(comparison.fmpPeriod, "2024-12-31");
  const nvda = comparison.rows.find((r) => r.ticker === "NVDA");
  const aapl = comparison.rows.find((r) => r.ticker === "AAPL");
  const googl = comparison.rows.find((r) => r.ticker === "GOOGL");
  assert.deepEqual([nvda?.presence, nvda?.trackerPercentage, nvda?.fmpWeightBps], ["both", 15.16, 1553]);
  assert.equal(aapl?.presence, "both");
  assert.equal(googl?.presence, "both");
  assert.equal(googl?.fmpWeightBps, 1553);
  assert.deepEqual(nvda?.fmpAnnualBand, { low: 5000001, high: 25000000 });
  assert.ok(comparison.overlap.tickers.includes("NVDA"));
  assert.equal(comparison.rows.length, pelosi.topHoldings.length);
  const none = compareWithFmp(pelosi, null, null);
  assert.equal(none.fmpPublished, false);
  assert.equal(none.rows.length, 15);
  assert.match(none.note, /No saved FMP annual book or published FMP index/);
});
