import assert from "node:assert/strict";
import test from "node:test";
import { PublicKey } from "@solana/web3.js";
import { RebalanceAction, RebalanceType } from "@symmetry-hq/sdk/dist/layouts/intents/rebalanceIntent.js";
import { handleIndexPosition, handleIndexPositions, pendingNativeDeposit, pendingNativeOperation, pendingNativeOperationForPosition, readOwnedIndexPositions } from "../src/lib/index-vaults/index-positions.ts";
import type { PublicVaultDefinition } from "../src/lib/index-vaults/vault-definition-store.ts";

const owner = "C7ye6UvJ7jirwCmt3fKmt55MvcW9yBVpgqzZzgCWYQyB";
const vault = "AwDFvjEPPwdF1YgXV8asNt6LeEFDduinYneCn6mHDAsh";
const mint = "9ihGfswnUZ6MysSR3KgmrZ57FXDVAiAQ6sEHwLuWwzJ4";
const index = (id = "idx-theme-mag7-caucus"): PublicVaultDefinition => ({
  indexId: id, kind: "thematic", personSlug: "mag7-caucus", bioguideId: null, name: "Mag7 Caucus", symbol: "MAG7",
  status: "CREATABLE", network: "mainnet-beta", weightBasis: "thematic", depositsEnabled: true, depositReason: null,
  coverage: {}, provenance: {}, legs: [], unmapped: [], vaultAddress: vault, shareMint: mint, updatedAt: "2026-09-20T00:00:00Z",
});
const request = (path = "/api/positions/indexes", wallet = owner) => new Request(`https://insiderindex.xyz${path}?wallet=${wallet}`);

test("portfolio keeps only positive native share balances and never turns a failed read into zero", async () => {
  const positions = await readOwnedIndexPositions(owner, [index(), index("idx-theme-other")], async (definition, wallet) => {
    assert.equal(wallet, owner);
    if (definition.indexId === "idx-theme-other") throw new Error("RPC unavailable");
    return { indexId: definition.indexId, indexName: definition.name, owner: wallet, shareMint: mint, shareDecimals: 6, sharesRaw: "0" };
  }).then(() => assert.fail("a failed vault read must not be silently omitted"), error => error);
  assert.match(String(positions), /RPC unavailable/);
  const owned = await readOwnedIndexPositions(owner, [index()], async (definition, wallet) => ({
    indexId: definition.indexId, indexName: definition.name, owner: wallet, shareMint: mint, shareDecimals: 6, sharesRaw: "42",
  }));
  assert.deepEqual(owned.map(position => [position.indexId, position.sharesRaw]), [["idx-theme-mag7-caucus", "42"]]);
});

test("position endpoint exposes only a chain-backed locked native deposit as pending", () => {
  const intent = {
    formatted_data: { pubkey: "native-intent" }, mint_data: null,
    chain_data: { vault: new PublicKey(vault), owner: new PublicKey(owner), rebalanceType: RebalanceType.Deposit, currentAction: RebalanceAction.UpdatePrices },
  };
  assert.deepEqual(pendingNativeDeposit(intent as never, vault, mint, owner), {
    operationId: "native-deposit-native-intent", identity: { vaultAccount: vault, shareMint: mint }, owner, kind: "deposit", phase: "PRICING", nativeIntent: "native-intent", complete: false, blockers: ["Deposit pending settlement"],
  });
  assert.equal(pendingNativeDeposit({ ...intent, chain_data: { ...intent.chain_data, currentAction: RebalanceAction.NotActive } } as never, vault, mint, owner), null);
  assert.throws(() => pendingNativeDeposit({ ...intent, chain_data: { ...intent.chain_data, owner: new PublicKey(mint) } } as never, vault, mint, owner), /identity mismatch/);
  const withdrawal = { ...intent, chain_data: { ...intent.chain_data, rebalanceType: RebalanceType.Withdraw, currentAction: RebalanceAction.Auction } } as never;
  assert.equal(pendingNativeDeposit(withdrawal, vault, mint, owner), null, "a locked cash out is not mislabeled as a deposit");
  assert.deepEqual(pendingNativeOperation(withdrawal, vault, mint, owner), {
    operationId: "native-withdraw-native-intent", identity: { vaultAccount: vault, shareMint: mint }, owner, kind: "withdraw", phase: "AUCTION", nativeIntent: "native-intent", complete: false, blockers: ["Cash out pending settlement"],
  });
  assert.equal(pendingNativeOperationForPosition(withdrawal, vault, mint, owner, "3"), null, "minted dust shares are the receipt; the leftover intent is not resumable");
  assert.deepEqual(pendingNativeOperationForPosition(withdrawal, vault, mint, owner, "0"), pendingNativeOperation(withdrawal, vault, mint, owner));
});

test("position endpoints accept only the connected wallet and return chain-backed positions", async () => {
  const readPosition = async (definition: PublicVaultDefinition & { network: "mainnet-beta" | "devnet"; vaultAddress: string; shareMint: string }, wallet: string) => ({
    indexId: definition.indexId, indexName: definition.name, owner: wallet, shareMint: definition.shareMint, shareDecimals: 6, sharesRaw: "1000000",
  });
  const one = await handleIndexPosition(request(`/api/indexes/${index().indexId}/position`), index().indexId, { getIndex: async () => index(), readPosition });
  assert.equal(one.status, 200);
  const alias = await handleIndexPosition(new Request(`https://insiderindex.xyz/api/indexes/${index().indexId}/position?owner=${owner}`), index().indexId, { getIndex: async () => index(), readPosition });
  assert.equal(alias.status, 400);
  assert.deepEqual(await one.json(), { indexId: "idx-theme-mag7-caucus", indexName: "Mag7 Caucus", owner, shareMint: mint, shareDecimals: 6, sharesRaw: "1000000" });
  const all = await handleIndexPositions(request(), { listIndexes: async () => [index()], readPosition });
  assert.equal(all.status, 200);
  assert.deepEqual((await all.json()).positions.map((position: { indexId: string }) => position.indexId), ["idx-theme-mag7-caucus"]);
  const pending = await handleIndexPositions(request(), { listIndexes: async () => [index()], readPosition: async (definition, wallet) => ({
    indexId: definition.indexId, indexName: definition.name, owner: wallet, shareMint: definition.shareMint, shareDecimals: 6, sharesRaw: "0",
    pendingOperations: [{ operationId: "native-deposit-locked", kind: "deposit", phase: "AUCTION", complete: false, blockers: ["Deposit pending settlement"] }],
  }) });
  assert.deepEqual(await pending.json(), { positions: [{
    indexId: "idx-theme-mag7-caucus", indexName: "Mag7 Caucus", owner, shareMint: mint, shareDecimals: 6, sharesRaw: "0",
    pendingOperations: [{ operationId: "native-deposit-locked", kind: "deposit", phase: "AUCTION", complete: false, blockers: ["Deposit pending settlement"] }],
  }] }, "the portfolio response preserves locked native deposits instead of calling it empty");
  for (const wallet of ["", "not-a-wallet", "privy-stub:test"]) {
    const response = await handleIndexPositions(request("/api/positions/indexes", wallet), { listIndexes: async () => [index()], readPosition });
    assert.equal(response.status, 400);
  }
});
