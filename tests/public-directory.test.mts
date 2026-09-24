import test from "node:test";
import assert from "node:assert/strict";
import { publicVaultDirectory } from "../src/lib/index-vaults/public-directory.ts";
import { readVaultDefinition, readVaultDefinitions, type PublicVaultDefinition } from "../src/lib/index-vaults/vault-definition-store.ts";

test("research directory preserves the disclosed definition without authorizing historical custody", () => {
  const index: PublicVaultDefinition = {
    indexId: "insiderindex-test", kind: "person", personSlug: "test", bioguideId: null,
    name: "Test Index", symbol: "TEST", status: "CREATABLE", network: "mainnet-beta",
    weightBasis: "annual", depositsEnabled: true, publicFundsEnabled: true, depositReason: null,
    coverage: {}, provenance: {}, legs: [], unmapped: [{ ticker: "UNMAPPED", reason: "no-solana-mint" }],
    vaultAddress: "historical-vault", shareMint: "historical-share", updatedAt: "2026-09-23",
  };
  const directory = publicVaultDirectory([index]);
  assert.equal(directory.count, 1);
  assert.equal(directory.publicFundsEnabled, false);
  assert.deepEqual(directory.indexes[0], { ...index, publicFundsEnabled: false });
  assert.equal(index.publicFundsEnabled, true, "projection must not mutate the saved definition");
  assert.deepEqual(publicVaultDirectory([]).indexes, []);
});

test("NAV keeper definition readers preserve the persisted RPC contract and fail closed on storage errors", async () => {
  const calls: unknown[] = [];
  const saved = { indexId: "idx-theme-mag7-caucus", vaultLegs: [{ mint: "fixture", targetWeightBps: 10000 }] };
  const db = { rpc: async (fn: string, args?: unknown) => { calls.push([fn, args]); return { data: fn.endsWith("definitions") ? [saved] : saved, error: null }; } };
  assert.deepEqual(await readVaultDefinition(db as never, saved.indexId), saved);
  assert.deepEqual(await readVaultDefinitions(db as never), [saved]);
  assert.deepEqual(calls, [
    ["read_insiderindex_vault_definition", { p_index_id: saved.indexId }],
    ["read_insiderindex_vault_definitions", undefined],
  ]);
  const failed = { rpc: async () => ({ data: null, error: { code: "offline" } }) };
  await assert.rejects(readVaultDefinition(failed as never, saved.indexId), /read failed/);
  await assert.rejects(readVaultDefinitions(failed as never), /read failed/);
});
