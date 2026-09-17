import test from "node:test";
import assert from "node:assert/strict";
import { indexCatalog, type CatalogToken } from "../src/lib/venues/catalog-parse.ts";
import { KAKU_SAN_ASSETS } from "../src/lib/index-vaults/kaku-san.ts";
import {
  allocateBps, derivePersonIndex, holdingValue, NATIVE_TOKEN_CAP, type PersonBook,
} from "../src/lib/index-vaults/person-index-map.ts";
import { buildPersonVaultInit } from "../src/lib/index-vaults/person-vault-init.ts";
import { PENDING_POOL_SOURCE, poolSourceFromEvidence, type PoolEvidence } from "../src/lib/index-vaults/pool-evidence.ts";

/** Real, valid mint+pool pairs so the vault-init builder's address/oracle guards run for real. */
const A = KAKU_SAN_ASSETS[0], B = KAKU_SAN_ASSETS[1], C = KAKU_SAN_ASSETS[2];
const xstock = (ticker: string, symbol: string, mint: string): CatalogToken => ({ issuer: "xstock", ticker, symbol, name: symbol, mint, decimals: 8 });
const backpack = (ticker: string, symbol: string, mint: string): CatalogToken => ({ issuer: "backpack", ticker, symbol, name: symbol, mint, decimals: 6 });

const observed = (mint: string, pool: string, kind = "raydium_clmm", tvlUsd = 250_000): PoolEvidence => ({
  mint, pool, kind, programId: "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK", quoteMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", tvlUsd, observedAt: "2026-09-16T00:00:00Z",
});

function book(overrides: Partial<PersonBook> & Pick<PersonBook, "slug">): PersonBook {
  return {
    slug: overrides.slug, bioguideId: overrides.bioguideId ?? "X000001", name: overrides.name ?? "Test Person",
    party: null, state: null, title: null, fmpYear: overrides.fmpYear ?? 2024,
    bookSource: overrides.bookSource ?? "fmp-annual-latest+txn", annualFetchComplete: overrides.annualFetchComplete ?? true,
    holdings: overrides.holdings ?? [], holdingsFromTransactions: overrides.holdingsFromTransactions ?? [],
  };
}

test("resolution order: xStock preferred, Backpack fallback, else unmapped", () => {
  // AAPL has both issuers (xStock must win); MSFT only Backpack; TSLA has neither.
  const catalog = indexCatalog([
    xstock("AAPL", "AAPLx", A.mint), backpack("AAPL", "AAPL.US", B.mint),
    backpack("MSFT", "MSFT.US", C.mint),
  ]);
  const def = derivePersonIndex(book({
    slug: "res", holdings: [
      { ticker: "AAPL", value: 100 }, { ticker: "MSFT", value: 100 }, { ticker: "TSLA", value: 100 },
    ],
  }), catalog, PENDING_POOL_SOURCE);
  const legByTicker = new Map(def.legs.map((l) => [l.ticker, l]));
  assert.equal(legByTicker.get("AAPL")!.provider, "xstock");
  assert.equal(legByTicker.get("AAPL")!.mint, A.mint);
  assert.equal(legByTicker.get("MSFT")!.provider, "backpack");
  assert.equal(legByTicker.get("MSFT")!.mint, C.mint);
  assert.ok(!legByTicker.has("TSLA"));
  assert.deepEqual(def.unmapped.map((u) => u.ticker), ["TSLA"]);
  assert.equal(def.unmapped[0].reason, "no-solana-mint");
});

test("lookalike rejection: only exact catalog mints, never a similar ticker or guessed mint", () => {
  const catalog = indexCatalog([xstock("GOOGL", "GOOGLx", A.mint), xstock("NVDA", "NVDAx", B.mint)]);
  const def = derivePersonIndex(book({
    slug: "look", holdings: [{ ticker: "GOOG", value: 50 }, { ticker: "NVDA", value: 50 }],
  }), catalog, PENDING_POOL_SOURCE);
  // GOOG must NOT borrow GOOGL's mint; NVDA maps to its own exact mint.
  assert.deepEqual(def.unmapped.map((u) => u.ticker), ["GOOG"]);
  assert.equal(def.legs.length, 1);
  assert.equal(def.legs[0].ticker, "NVDA");
  assert.equal(def.legs[0].mint, B.mint);
  // Every mapped mint is a mint the catalog actually indexed.
  for (const leg of def.legs) assert.ok(catalog.byMint.has(leg.mint));
});

test("transaction-derived books never become weights and stay blocked", () => {
  const catalog = indexCatalog([xstock("AAPL", "AAPLx", A.mint), xstock("NVDA", "NVDAx", B.mint)]);
  const def = derivePersonIndex(book({
    slug: "txn", bookSource: "txn-derived", fmpYear: null, holdings: [],
    holdingsFromTransactions: [{ ticker: "AAPL", tradeCount: 12 }, { ticker: "NVDA", tradeCount: 3 }],
  }), catalog, poolSourceFromEvidence([observed(A.mint, A.pool), observed(B.mint, B.pool)]));
  assert.equal(def.status, "BLOCKED");
  assert.deepEqual(def.blockedReasons, ["txn-derived-book"]);
  assert.equal(def.weightBasis, "none-txn-derived");
  assert.equal(def.legs.length, 0);
  assert.equal(def.coverage.mappableByWeightBps, 0);
  // Activity is resolved for information only — never a weight.
  assert.equal(def.activity.length, 2);
  assert.ok(def.activity.every((a) => !("targetWeightBps" in a)));
  assert.throws(() => buildPersonVaultInit(def), /NOT_WEIGHTABLE/);
});

test("weight bps integrity: legs sum to 10000, unmapped share disclosed", () => {
  const catalog = indexCatalog([xstock("AAPL", "AAPLx", A.mint), xstock("NVDA", "NVDAx", B.mint), xstock("MSFT", "MSFTx", C.mint)]);
  const def = derivePersonIndex(book({
    slug: "wts", holdings: [
      { ticker: "AAPL", value: 500 }, { ticker: "NVDA", value: 300 }, { ticker: "MSFT", value: 100 },
      { ticker: "TSLA", value: 100 }, // unmapped: 100/1000 = 10% of the book
      { ticker: "CASH", value: 0 }, // zero value: never weighted
    ],
  }), catalog, PENDING_POOL_SOURCE);
  const legSum = def.legs.reduce((s, l) => s + l.targetWeightBps, 0);
  assert.equal(legSum, 10_000);
  assert.ok(def.legs.every((l) => l.targetWeightBps >= 1));
  // Book weights (mapped + unmapped) also sum to 10000; unmapped ~10%.
  assert.equal(def.coverage.mappableByWeightBps + def.coverage.unmappedByWeightBps, 10_000);
  assert.equal(def.coverage.unmappedByWeightBps, 1000);
  assert.equal(def.provenance.unweightedTickerCount, 1); // CASH
});

test("allocateBps: sums to 10000, floors to 1 bp, largest-remainder", () => {
  assert.deepEqual(allocateBps([1, 1]), [5000, 5000]);
  assert.equal(allocateBps([1, 1, 1]).reduce((a, b) => a + b, 0), 10_000);
  const many = allocateBps(new Array(97).fill(1));
  assert.equal(many.reduce((a, b) => a + b, 0), 10_000);
  assert.ok(many.every((b) => b >= 1));
  // A dominant leg and a tiny one still both keep at least 1 bp.
  const skew = allocateBps([9999, 1]);
  assert.equal(skew.reduce((a, b) => a + b, 0), 10_000);
  assert.ok(skew.every((b) => b >= 1));
});

test("holdingValue prefers disclosed midpoint, else band midpoint, else 0", () => {
  assert.equal(holdingValue({ ticker: "X", value: 500 }), 500);
  assert.equal(holdingValue({ ticker: "X", value: null, valueRange: { min: 1000, max: 3000 } }), 2000);
  assert.equal(holdingValue({ ticker: "X", value: null, valueRange: null }), 0);
});

test("pool gating: pending source waits, observed pools make it creatable", () => {
  const catalog = indexCatalog([xstock("AAPL", "AAPLx", A.mint), xstock("NVDA", "NVDAx", B.mint), xstock("MSFT", "MSFTx", C.mint)]);
  const holdings = [{ ticker: "AAPL", value: 500 }, { ticker: "NVDA", value: 300 }, { ticker: "MSFT", value: 200 }];

  const pending = derivePersonIndex(book({ slug: "pend", holdings }), catalog, PENDING_POOL_SOURCE);
  assert.equal(pending.status, "WAIT_POOL_EVIDENCE");
  assert.equal(pending.coverage.vaultReadyLegCount, 0);
  assert.throws(() => buildPersonVaultInit(pending), /INSUFFICIENT_POOL_READY_LEGS/);

  const pools = poolSourceFromEvidence([observed(A.mint, A.pool), observed(B.mint, B.pool), observed(C.mint, C.pool)]);
  const ready = derivePersonIndex(book({ slug: "ready", holdings }), catalog, pools);
  assert.equal(ready.status, "CREATABLE");
  assert.equal(ready.coverage.vaultReadyLegCount, 3);
  const init = buildPersonVaultInit(ready);
  assert.equal(init.legs.length, 3);
  assert.equal(init.legs.reduce((s, l) => s + l.targetWeightBps, 0), 10_000);
  assert.equal(init.hostEntryFeeBps, 25);
  assert.equal(init.hostExitFeeBps, 0);
  assert.ok(init.legs.every((l) => l.pool && l.kind.startsWith("raydium_")));
});

test("thin pools are recorded, not silently used", () => {
  const catalog = indexCatalog([xstock("AAPL", "AAPLx", A.mint), xstock("NVDA", "NVDAx", B.mint)]);
  const pools = poolSourceFromEvidence([observed(A.mint, A.pool, "raydium_clmm", 9_000), observed(B.mint, B.pool)]);
  const def = derivePersonIndex(book({ slug: "thin", holdings: [{ ticker: "AAPL", value: 500 }, { ticker: "NVDA", value: 500 }] }), catalog, pools);
  const aapl = def.legs.find((l) => l.ticker === "AAPL")!;
  assert.equal(aapl.pool.status, "thin");
  assert.equal(aapl.vaultReady, false);
  assert.equal(def.coverage.vaultReadyLegCount, 1);
  assert.equal(def.status, "WAIT_POOL_EVIDENCE"); // only 1 vault-ready leg
});

test("a not-ready leg never contributes to tradable coverage", () => {
  const M = { AAPL: "MINT_AAPL_TRAD", NVDA: "MINT_NVDA_TRAD", MSFT: "MINT_MSFT_TRAD", TSLA: "MINT_TSLA_TRAD" };
  const catalog = indexCatalog([
    xstock("AAPL", "AAPLx", M.AAPL), xstock("NVDA", "NVDAx", M.NVDA),
    xstock("MSFT", "MSFTx", M.MSFT), xstock("TSLA", "TSLAx", M.TSLA),
  ]);
  // AAPL & NVDA have real tradable pools; MSFT's pool is thin (below floor); TSLA has no pool.
  const pools = poolSourceFromEvidence([
    observed(M.AAPL, "POOL_AAPL"), observed(M.NVDA, "POOL_NVDA"),
    observed(M.MSFT, "POOL_MSFT", "raydium_clmm", 5_000),
  ]);
  const def = derivePersonIndex(book({ slug: "trad", holdings: [
    { ticker: "AAPL", value: 400 }, { ticker: "NVDA", value: 300 },
    { ticker: "MSFT", value: 200 }, { ticker: "TSLA", value: 100 },
  ] }), catalog, pools);
  const byT = new Map(def.legs.map((l) => [l.ticker, l]));
  // All four resolve to a mint, so catalog coverage is the whole book.
  assert.equal(def.coverage.mappedLegCount, 4);
  assert.equal(def.coverage.mappableByWeightBps, 10_000);
  // Tradable coverage counts ONLY the two legs with a real, tradable pool — never the thin/absent ones.
  const expectedTradable = byT.get("AAPL")!.bookWeightBps + byT.get("NVDA")!.bookWeightBps;
  assert.equal(def.coverage.tradableByWeightBps, expectedTradable);
  assert.equal(byT.get("MSFT")!.vaultReady, false); // thin
  assert.equal(byT.get("TSLA")!.vaultReady, false); // no pool
  assert.equal(def.coverage.vaultReadyLegCount, 2);
  // The mapped-but-untradable weight is disclosed as the gap, not silently re-weighted away.
  assert.equal(
    def.coverage.mappableByWeightBps - def.coverage.tradableByWeightBps,
    byT.get("MSFT")!.bookWeightBps + byT.get("TSLA")!.bookWeightBps,
  );
  assert.equal(def.status, "CREATABLE");
});

test("a non-Raydium pool kind fails closed, never coerced to CLMM", () => {
  const catalog = indexCatalog([xstock("AAPL", "AAPLx", A.mint), xstock("NVDA", "NVDAx", B.mint)]);
  // Both pools are "observed" (above the TVL floor) but one carries a non-Raydium kind.
  const pools = poolSourceFromEvidence([observed(A.mint, A.pool, "orca_whirlpool"), observed(B.mint, B.pool, "raydium_clmm")]);
  const def = derivePersonIndex(book({ slug: "kind", holdings: [{ ticker: "AAPL", value: 500 }, { ticker: "NVDA", value: 500 }] }), catalog, pools);
  assert.equal(def.status, "CREATABLE");
  assert.throws(() => buildPersonVaultInit(def), /ORACLE_KIND_FORBIDDEN/);
});

test("duplicate underlyings in one basket are caught: same-company share classes collapse to one leg", () => {
  // GOOGL (Class A) resolves to a tradable xStock; GOOG (Class C) only to an illiquid Backpack
  // token. They are ONE company (Alphabet), so the basket must carry one Alphabet leg, not two.
  const catalog = indexCatalog([xstock("GOOGL", "GOOGLx", A.mint), backpack("GOOG", "GOOG.US", B.mint), xstock("AAPL", "AAPLx", C.mint)]);
  const def = derivePersonIndex(
    book({ slug: "dup", holdings: [{ ticker: "GOOGL", value: 600 }, { ticker: "GOOG", value: 300 }, { ticker: "AAPL", value: 100 }] }),
    catalog,
    PENDING_POOL_SOURCE,
  );
  // Exactly one Alphabet leg, and it is the tradable xStock (GOOGL), never the illiquid GOOG.
  const alphabet = def.legs.filter((l) => l.ticker === "GOOGL" || l.ticker === "GOOG");
  assert.equal(alphabet.length, 1);
  assert.equal(alphabet[0].ticker, "GOOGL");
  assert.equal(alphabet[0].provider, "xstock");
  assert.ok(!def.legs.some((l) => l.ticker === "GOOG"), "the illiquid GOOG duplicate must be gone");
  // Its weight is folded in, not discarded: GOOGL now carries the merged GOOGL+GOOG value (900).
  assert.equal(alphabet[0].valueBasis, 900);
  // The collapse is recorded on provenance so it is deliberate, never silent.
  assert.deepEqual(def.provenance.collapsedShareClasses, [{ underlying: "GOOGL", keptTicker: "GOOGL", droppedTickers: ["GOOG"], mergedValueBasis: 900 }]);
  assert.match(def.provenance.note, /Collapsed duplicate share-class legs: GOOG\u2192GOOGL/);
  // Weights still sum correctly after the collapse: target weights over mapped legs total 10000,
  // and book weights over mapped + unmapped total 10000.
  assert.equal(def.legs.reduce((s, l) => s + l.targetWeightBps, 0), 10_000);
  assert.equal(
    def.legs.reduce((s, l) => s + l.bookWeightBps, 0) + def.unmapped.reduce((s, u) => s + u.bookWeightBps, 0),
    10_000,
  );
});

test("native leg cap: a book mapping past the cap throws, never truncates", () => {
  const tokens: CatalogToken[] = [];
  const holdings = [];
  for (let i = 0; i < NATIVE_TOKEN_CAP + 1; i++) {
    const ticker = `TK${i}`;
    tokens.push(xstock(ticker, `${ticker}x`, `MINT_${i}`));
    holdings.push({ ticker, value: 100 + i });
  }
  const catalog = indexCatalog(tokens);
  // Every mint is "observed" so all become vault-ready legs (> cap).
  const pools = poolSourceFromEvidence(tokens.map((t) => observed(t.mint, `POOL_${t.mint}`)));
  const def = derivePersonIndex(book({ slug: "cap", holdings }), catalog, pools);
  assert.equal(def.legs.length, NATIVE_TOKEN_CAP + 1);
  assert.ok(def.blockedReasons.includes("native-token-cap-exceeded"));
  assert.equal(def.status, "BLOCKED");
  assert.throws(() => buildPersonVaultInit(def), /NATIVE_TOKEN_CAP/);
});
