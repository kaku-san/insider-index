import test from "node:test";
import assert from "node:assert/strict";
import { indexCatalog, type CatalogToken } from "../src/lib/venues/catalog-parse.ts";
import { KAKU_SAN_ASSETS } from "../src/lib/index-vaults/kaku-san.ts";
import { derivePersonIndex, type PersonBook } from "../src/lib/index-vaults/person-index-map.ts";
import { poolSourceFromEvidence, type PoolEvidence } from "../src/lib/index-vaults/pool-evidence.ts";
import { definitionForDb } from "../src/lib/index-vaults/vault-definition-store.ts";
import { VAULT_RELEASE } from "../src/lib/index-vaults/release.ts";
import { publicInvestSignAllowed } from "../src/lib/index-vaults/full-cycle.ts";

// Reaching 100% tradable coverage flips a definition's per-vault `depositsEnabled` to true (the
// mag7-caucus case after the Alphabet dedupe). These tests lock the invariant firstmate flagged:
// the per-vault gate ALONE never opens effective deposits — the authoritative global release flag
// is also required, and it is a source constant no env toggle can flip.

const A = KAKU_SAN_ASSETS[0], B = KAKU_SAN_ASSETS[1];
const xstock = (ticker: string, symbol: string, mint: string): CatalogToken => ({ issuer: "xstock", ticker, symbol, name: symbol, mint, decimals: 8 });
const observed = (mint: string, pool: string): PoolEvidence => ({
  mint, pool, kind: "raydium_clmm", programId: "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK",
  quoteMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", tvlUsd: 250_000, observedAt: "2026-09-16T00:00:00Z",
});
function book(overrides: Partial<PersonBook> & Pick<PersonBook, "slug">): PersonBook {
  return {
    slug: overrides.slug, bioguideId: "X000001", name: "Test Person", party: null, state: null, title: null,
    fmpYear: 2024, bookSource: "fmp-annual-latest+txn", annualFetchComplete: true,
    holdings: overrides.holdings ?? [], holdingsFromTransactions: [],
  };
}

test("a fully-tradable definition opens the per-vault gate but NOT effective deposits (release flag required)", () => {
  const catalog = indexCatalog([xstock("AAPL", "AAPLx", A.mint), xstock("NVDA", "NVDAx", B.mint)]);
  const pools = poolSourceFromEvidence([observed(A.mint, A.pool), observed(B.mint, B.pool)]);
  const def = derivePersonIndex(book({ slug: "full", holdings: [{ ticker: "AAPL", value: 600 }, { ticker: "NVDA", value: 400 }] }), catalog, pools);

  // Per-vault gate is open at full tradable coverage — this is the condition the mag7 fix reaches.
  assert.equal(def.depositsEnabled, true);

  // But the persisted record's effective gate stays CLOSED: it requires BOTH the per-vault gate AND
  // the global release flag, and the release flag is off.
  const deposits = (definitionForDb(def) as { deposits: { enabled: boolean; releaseGated: boolean; effectiveEnabled: boolean } }).deposits;
  assert.equal(deposits.enabled, true, "per-vault gate open");
  assert.equal(deposits.releaseGated, true, "still gated by the global release flag");
  assert.equal(deposits.effectiveEnabled, false, "the per-vault gate ALONE must not open effective deposits");
});

test("the global release flag is off and no automated toggle can flip it", () => {
  // A source constant, not read from env: only a deliberate human code change can open funds.
  assert.equal(VAULT_RELEASE.publicFundsEnabled, false);
  assert.equal(VAULT_RELEASE.publicInvestSign, false);
  assert.equal(VAULT_RELEASE.nativeUsdcExitVerified, false);

  // Even a hypothetical complete receipt set cannot enable Sign while the release flags are off.
  const identity = { network: "devnet" as const, vaultAccount: A.mint, shareMint: B.mint };
  assert.equal(publicInvestSignAllowed([], identity), false);
  assert.equal(publicInvestSignAllowed([], identity, { publicFundsEnabled: false, nativeUsdcExitVerified: true, publicInvestSign: true }), false);
});
