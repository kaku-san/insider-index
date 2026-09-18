import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import { Keypair } from "@solana/web3.js";
import { snapshotCatalog } from "../src/lib/venues/solana-catalog.ts";
import { poolSourceFromReadiness } from "../src/lib/index-vaults/pool-evidence.ts";
import { mainnetRaydiumPoolSnapshot, poolReadiness } from "../src/lib/index-vaults/raydium-pools-mainnet.ts";
import { deriveAllPersonIndexes, toPersonBook } from "../src/lib/index-vaults/person-index-source.ts";
import { deriveAllThematicIndexes } from "../src/lib/index-vaults/thematic-index-map.ts";
import { definitionForDb, type PersistedVaultDefinition } from "../src/lib/index-vaults/vault-definition-store.ts";
import { cycleDefinitionHash, assertCycleDefinition, assertCyclePolicy, cycleActivationBlockers, assertCycleExecutionAuthorized, cycleScope, type CyclePolicy } from "../src/lib/index-vaults/cycle-policy.ts";
import { definition as mag7 } from "./support/composition-vm.mts";
import { VAULT_RELEASE } from "../src/lib/index-vaults/release.ts";
const owner = Keypair.fromSeed(new Uint8Array(32).fill(30)).publicKey.toBase58(), keeper = Keypair.fromSeed(new Uint8Array(32).fill(31)).publicKey.toBase58();
function record(): PersistedVaultDefinition { return { ...structuredClone(mag7), keeper: { pubkey: keeper, automationEnabled: true } }; }
function policy(r = record()): CyclePolicy { return { schema: "insiderindex-cycle-policy-v1", indexId: r.indexId, vault: r.vaultAddress!, shareMint: r.shareMint!, definitionHash: cycleDefinitionHash(r), owner, keeper, operationId: "00000000-0000-4000-8000-000000000001", expiresAt: Date.now() + 60000, notBeforeSlot: 0, approvalReference: null, feeScheduleHash: null, financialExecutionAuthorized: false,
  economics: { keeperSurplus: "unapproved", shareQuantization: "unapproved", residualCash: "unapproved", issuerAuthorityRiskApproved: false, nativeSettlementRiskApproved: false },
  limits: { depositUsdcRaw: "100000000", minNetSharesRaw: "1", minExitUsdcRaw: "99000000", maxOwnerSolDebitLamports: "10000000", maxKeeperSolDebitLamports: "10000000", maxBountyRaw: "0", maxRoundingLossUsdcRaw: "0", maxKeeperSurplusUsdcRaw: "0", swapSlippageBps: 50, maxSettlementDriftBps: 100, rebalanceSlippageBps: 100, perTradeSlippageBps: 50, maxComputeUnits: 1400000, maxMicroLamports: "0", quoteMaxAgeMs: 30000 } }; }

test("pilot authority is explicit, expiring and isolated by definition, vault, mint, wallet, keeper and operation", () => {
  const r = record(), p = policy(r);
  assertCyclePolicy(p, r);
  assert.equal(cycleActivationBlockers(p).length, 7);
  assert.throws(() => assertCycleExecutionAuthorized(p, r), /EXECUTION_DISABLED/);
  assert.throws(() => assertCyclePolicy({ ...p, definitionHash: "0".repeat(64) }, r), /IDENTITY_CHANGED/);
  assert.throws(() => assertCyclePolicy({ ...p, expiresAt: Date.now() - 1 }, r), /EXPIRED/);
  assert.throws(() => assertCyclePolicy({ ...p, keeper: owner }, r), /ROLE_OR_OPERATION/);
  assert.throws(() => assertCyclePolicy({ ...p, operationId: "--------0000-4000-8000-000000000001" }, r), /ROLE_OR_OPERATION/);
  assert.throws(() => assertCyclePolicy({ ...p, limits: { ...p.limits, depositUsdcRaw: "9007199254740992" } }, r), /exact JavaScript/);
  assert.notEqual(cycleScope(p), cycleScope({ ...p, operationId: "00000000-0000-4000-8000-000000000002" }));
  assert.notEqual(cycleScope(p), cycleScope({ ...p, owner: keeper }));
  assert.notEqual(cycleScope(p), cycleScope({ ...p, indexId: "idx-theme-silicon-hill" }));
  const changed = record(); changed.vaultLegs[0].targetWeightBps--; changed.vaultLegs[1].targetWeightBps++;
  assert.notEqual(cycleDefinitionHash(r), cycleDefinitionHash(changed));
  assert.throws(() => assertCyclePolicy(p, changed), /IDENTITY_CHANGED/);
  assert.equal(VAULT_RELEASE.publicFundsEnabled, false);
});
test("creation/readiness/caps/fees cannot be borrowed from another index or silently repaired", () => {
  const r = record(); assertCycleDefinition(r, r.indexId);
  for (const patch of [{ vaultAddress: null }, { shareMint: null }, { status: "BLOCKED" }, { network: "devnet" }]) assert.throws(() => assertCycleDefinition({ ...r, ...patch }, r.indexId), /UNCREATED_OR_UNREADY/);
  for (const patch of [{ depositsEnabled: false }, { coverage: { poolReadyOfMappedBps: 9999 } }, { poolExcludedLegs: [{ ticker: "X", mint: owner, reason: "no-pool" }] }]) assert.throws(() => assertCycleDefinition({ ...r, ...patch }, r.indexId), /PARTIAL_COVERAGE/);
  const closed = { ...r, depositsEnabled: false, keeper: { ...r.keeper, automationEnabled: false } };
  assertCycleDefinition(closed, r.indexId, "recovery");
  assertCyclePolicy(policy(r), closed, Date.now(), "recovery");
  assert.throws(() => assertCycleDefinition({ ...r, hostEntryFeeBps: 0 }, r.indexId), /FEE_POLICY/);
  assert.throws(() => assertCycleDefinition({ ...r, nativeTokenCap: 6 }, r.indexId), /TOKEN_CAP/);
  const thin = record(); thin.vaultLegs[0].tvlUsd = 9999;
  assert.throws(() => assertCycleDefinition(thin, thin.indexId), /LEG_UNREADY/);
  assert.throws(() => assertCycleDefinition(r, "insiderindex-nancy-pelosi"), /SUBSTITUTED/);
});
test("actual Pelosi, Gottheimer, Mag7 and Silicon Hill source derivations retain independent books and readiness", () => {
  const snapshot = mainnetRaydiumPoolSnapshot(), catalog = snapshotCatalog();
  // Historical derivation regression, not fresh live pool evidence or invented liquidity.
  const source = poolSourceFromReadiness(m => poolReadiness(m, snapshot.pools), { fetchedAt: snapshot.fetchedAt, source: snapshot.source });
  const root = new URL("../data/insiderindex-source-buckets/pelositracker-fmp-latest-top20/holdings/", import.meta.url);
  const books = fs.readdirSync(root).filter(f => f.endsWith(".json")).map(f => toPersonBook(JSON.parse(fs.readFileSync(new URL(f, root), "utf8"))));
  const definitions = [...deriveAllPersonIndexes(books, catalog, source), ...deriveAllThematicIndexes(catalog, source)];
  const selected = ["nancy-pelosi", "josh-gottheimer", "idx-theme-mag7-caucus", "idx-theme-silicon-hill"].map(slug => definitions.find(d => d.slug === slug || d.indexId === slug));
  assert(selected.every(Boolean));
  const hashes = new Set<string>();
  for (const d of selected) {
    assert(d);
    const document = definitionForDb(d), r = { ...document, vaultAddress: null, shareMint: null, depositsEnabled: d.depositsEnabled } as PersistedVaultDefinition;
    assert.throws(() => assertCycleDefinition(r, d.indexId), /UNCREATED_OR_UNREADY/);
    assert.equal(r.vaultLegs.reduce((sum, l) => sum + l.targetWeightBps, 0), 10000);
    hashes.add(cycleDefinitionHash(r));
    assert.equal(r.kind, d.kind); assert.equal(r.vaultLegs.length, d.coverage.vaultReadyLegCount);
  }
  assert.equal(hashes.size, 4, "no shared Mag7 basket/identity hash for other indexes");
  assert(selected.find(d => d?.indexId === "idx-theme-silicon-hill")!.legs.some(l => l.ticker === "ORCL"));
});
