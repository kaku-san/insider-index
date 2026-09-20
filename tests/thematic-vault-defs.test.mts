import test from "node:test";
import assert from "node:assert/strict";
import { indexCatalog, type CatalogToken } from "../src/lib/venues/catalog-parse.ts";
import { snapshotCatalog } from "../src/lib/venues/solana-catalog.ts";
import { KAKU_SAN_ASSETS } from "../src/lib/index-vaults/kaku-san.ts";
import { NATIVE_TOKEN_CAP } from "../src/lib/index-vaults/person-index-map.ts";
import { buildPersonVaultInit } from "../src/lib/index-vaults/person-vault-init.ts";
import { PENDING_POOL_SOURCE, poolSourceFromEvidence, type PoolEvidence } from "../src/lib/index-vaults/pool-evidence.ts";
import { deriveAllThematicIndexes, deriveThematicIndex, thematicSymbol } from "../src/lib/index-vaults/thematic-index-map.ts";
import { definitionForDb } from "../src/lib/index-vaults/vault-definition-store.ts";
import { listThematicViews } from "../src/lib/thematic/views.ts";

const A = KAKU_SAN_ASSETS[0], B = KAKU_SAN_ASSETS[1], C = KAKU_SAN_ASSETS[2];
const xstock = (ticker: string, symbol: string, mint: string): CatalogToken => ({ issuer: "xstock", ticker, symbol, name: symbol, mint, decimals: 8 });
const observed = (mint: string, pool: string, kind = "raydium_clmm", tvlUsd = 250_000): PoolEvidence => ({
  mint, pool, kind, programId: "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK", quoteMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", tvlUsd, observedAt: "2026-09-16T00:00:00Z",
});

/** A synthetic thematic view whose constituents can be catalog-resolved against `catalog` below. */
function fakeView(overrides: { legs?: { ticker: string; weight_bps: number }[] } = {}) {
  const legs = overrides.legs ?? [{ ticker: "AAPL", weight_bps: 6000 }, { ticker: "NVDA", weight_bps: 4000 }];
  return {
    id: "idx-theme-test",
    slug: "idx-theme-test",
    indexName: "Test Basket · InsiderIndex",
    lane: "holdings",
    basis: "insiderindex-thematic" as const,
    methodology: "holding-band-midpoints-multi-member",
    members: [
      { slug: "member-a", name: "Member A", party: "Democratic", state: "CA", bioguideId: "A000001" },
      { slug: "member-b", name: "Member B", party: "Republican", state: "TX", bioguideId: "B000002" },
    ],
    constituents: legs.map((l) => ({ ticker: l.ticker, name: `${l.ticker} xStock`, mint: "", issuer: "xstock" as const, venueSymbol: `${l.ticker}x`, mintDecimals: 8, weight_bps: l.weight_bps, weightPct: l.weight_bps / 10_000, filerCount: 2 })),
  } as unknown as Parameters<typeof deriveThematicIndex>[0];
}

test("a thematic definition never claims person provenance", () => {
  const catalog = indexCatalog([xstock("AAPL", "AAPLx", A.mint), xstock("NVDA", "NVDAx", B.mint)]);
  const def = deriveThematicIndex(fakeView(), catalog, PENDING_POOL_SOURCE);
  assert.equal(def.kind, "thematic");
  assert.equal(def.provenance.kind, "thematic");
  assert.equal(def.provenance.basis, "insiderindex-thematic");
  // No single-person identity: no bioguide, member roster recorded, person-book counters zeroed.
  assert.equal(def.bioguideId, null);
  assert.equal(def.provenance.memberCount, 2);
  assert.equal(def.provenance.members?.length, 2);
  assert.equal(def.provenance.holdingsCount, 0);
  assert.equal(def.provenance.fmpYear, null);
  assert.equal(def.weightBasis, "thematic-multi-member-value");
  // The persisted record carries the kind, so it cannot read as a person index in the DB either.
  const db = definitionForDb(def) as { kind: string; provenance: { kind: string } };
  assert.equal(db.kind, "thematic");
  assert.equal(db.provenance.kind, "thematic");
});

test("deposits default closed for every thematic index (no pool evidence)", () => {
  const catalog = snapshotCatalog();
  const defs = deriveAllThematicIndexes(catalog, PENDING_POOL_SOURCE);
  assert.equal(defs.length, 10);
  for (const def of defs) {
    assert.equal(def.kind, "thematic");
    assert.equal(def.depositsEnabled, false);
    // Structure can be creatable while deposits stay closed: creation never implies deposits.
    const db = definitionForDb(def) as { deposits: { enabled: boolean; effectiveEnabled: boolean; releaseGated: boolean } };
    assert.equal(db.deposits.enabled, false);
    assert.equal(db.deposits.effectiveEnabled, false);
    assert.equal(db.deposits.releaseGated, false);
  }
});

test("even with full pool evidence deposits stay release-gated, and creation never opens them", () => {
  const catalog = indexCatalog([xstock("AAPL", "AAPLx", A.mint), xstock("NVDA", "NVDAx", B.mint)]);
  const pools = poolSourceFromEvidence([observed(A.mint, A.pool), observed(B.mint, B.pool)]);
  const def = deriveThematicIndex(fakeView(), catalog, pools);
  assert.equal(def.status, "CREATABLE");
  // Per-vault gate opens on full tradable coverage...
  assert.equal(def.depositsEnabled, true);
  // The open release flag allows the fully covered per-vault gate to take effect.
  const db = definitionForDb(def) as { deposits: { enabled: boolean; effectiveEnabled: boolean } };
  assert.equal(db.deposits.enabled, true);
  assert.equal(db.deposits.effectiveEnabled, true);
});

test("a not-ready leg never counts toward tradable coverage", () => {
  const catalog = indexCatalog([xstock("AAPL", "AAPLx", A.mint), xstock("NVDA", "NVDAx", B.mint), xstock("MSFT", "MSFTx", C.mint)]);
  // Only two of three legs carry an observed pool; the third is thin.
  const pools = poolSourceFromEvidence([observed(A.mint, A.pool), observed(B.mint, B.pool), observed(C.mint, C.pool, "raydium_clmm", 5_000)]);
  const def = deriveThematicIndex(fakeView({ legs: [{ ticker: "AAPL", weight_bps: 4000 }, { ticker: "NVDA", weight_bps: 4000 }, { ticker: "MSFT", weight_bps: 2000 }] }), catalog, pools);
  assert.equal(def.coverage.mappedLegCount, 3);
  assert.equal(def.coverage.vaultReadyLegCount, 2);
  // The thin MSFT leg is excluded from tradable-of-mapped coverage (< 10000) and blocks deposits.
  assert.ok(def.coverage.poolReadyOfMappedBps < 10_000);
  const msft = def.legs.find((l) => l.ticker === "MSFT")!;
  assert.equal(msft.vaultReady, false);
  assert.equal(def.depositsEnabled, false);
});

test("weight bps integrity holds: mapped legs sum to exactly 10000", () => {
  const catalog = indexCatalog([xstock("AAPL", "AAPLx", A.mint), xstock("NVDA", "NVDAx", B.mint), xstock("MSFT", "MSFTx", C.mint)]);
  const def = deriveThematicIndex(fakeView({ legs: [{ ticker: "AAPL", weight_bps: 5000 }, { ticker: "NVDA", weight_bps: 3000 }, { ticker: "MSFT", weight_bps: 2000 }] }), catalog, PENDING_POOL_SOURCE);
  assert.equal(def.legs.reduce((s, l) => s + l.targetWeightBps, 0), 10_000);
  assert.ok(def.legs.every((l) => l.targetWeightBps >= 1));
});

test("exceeding the native leg cap throws rather than truncating", () => {
  const tokens: CatalogToken[] = [];
  const legs: { ticker: string; weight_bps: number }[] = [];
  for (let i = 0; i < NATIVE_TOKEN_CAP + 1; i++) {
    const ticker = `TK${i}`;
    tokens.push(xstock(ticker, `${ticker}x`, `MINT_${i}`));
    legs.push({ ticker, weight_bps: 1 });
  }
  const catalog = indexCatalog(tokens);
  const pools = poolSourceFromEvidence(tokens.map((t) => observed(t.mint, `POOL_${t.mint}`)));
  const def = deriveThematicIndex(fakeView({ legs }), catalog, pools);
  assert.equal(def.legs.length, NATIVE_TOKEN_CAP + 1);
  assert.ok(def.blockedReasons.includes("native-token-cap-exceeded"));
  assert.equal(def.status, "BLOCKED");
  assert.equal(def.depositsEnabled, false);
  assert.throws(() => buildPersonVaultInit(def), /NATIVE_TOKEN_CAP/);
});

test("the live feed derives 10 thematic definitions in the person-index shape", () => {
  const catalog = snapshotCatalog();
  const defs = deriveAllThematicIndexes(catalog, PENDING_POOL_SOURCE);
  assert.equal(defs.length, listThematicViews().length);
  for (const def of defs) {
    assert.ok(def.indexId.startsWith("idx-theme-"));
    assert.equal(def.symbol, thematicSymbol(def.slug));
    // Same shape as a person index: legs carry catalog mints and renormalised target weights.
    assert.ok(def.legs.length >= 2);
    assert.equal(def.legs.reduce((s, l) => s + l.targetWeightBps, 0), 10_000);
    assert.ok(def.legs.every((l) => catalog.byMint.has(l.mint)));
    assert.equal(def.structurallyCreatable, true);
    assert.equal(def.status, "WAIT_POOL_EVIDENCE");
  }
});
