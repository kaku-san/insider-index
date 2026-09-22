import assert from "node:assert/strict";
import test from "node:test";
import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import { RebalanceAction, RebalanceType } from "@symmetry-hq/sdk/dist/layouts/intents/rebalanceIntent.js";
import { attachPositionNav, clmmSpotUsdcRaw, handleIndexPosition, handleIndexPositions, holdingsWithVaultBalances, installedRaydiumPool, markedVaultNavUsdc, nativeDepositAuctionState, pendingNativeDeposit, pendingNativeOperation, pendingNativeOperationForPosition, raydiumNavQuote, readOwnedIndexPositions, vaultNavHoldings } from "../src/lib/index-vaults/index-positions.ts";
import type { PublicVaultDefinition } from "../src/lib/index-vaults/vault-definition-store.ts";
import { MAINNET_USDC } from "../src/lib/index-vaults/native-defaults.ts";
import { RAYDIUM_ORACLE_KINDS, WSOL_MINT } from "../src/lib/index-vaults/raydium-oracles.ts";
import { formatVaultShares } from "../src/lib/index-vaults/positions-contract.ts";

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

test("a closed Mag7 deposit auction without basket fills is failed, while an open auction remains pending", () => {
  const intent = {
    formatted_data: { pubkey: "native-intent" }, mint_data: null,
    chain_data: {
      vault: new PublicKey(vault), owner: new PublicKey(owner), rebalanceType: RebalanceType.Deposit, currentAction: RebalanceAction.Auction,
      auctions: [{ endTime: new BN(100) }],
      tokens: [{ mint: new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"), amount: new BN(1) }],
    },
  };
  assert.equal(nativeDepositAuctionState(intent as never, 99_000), "PENDING");
  assert.equal(nativeDepositAuctionState(intent as never, 101_000), "FAILED");
  const operation = pendingNativeOperation(intent as never, vault, mint, owner, 101_000)!;
  assert.equal(operation.phase, "FAILED");
  assert.deepEqual(operation.blockers, ["This deposit did not buy the basket. Your USDC is still in Mag7 and is not shares."]);
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

const stock = new PublicKey(new Uint8Array(32).fill(7)).toBase58();
const pk = (value: string) => ({ toBase58: () => value });
const quote = (amountRaw: string, usdcRaw: string) => ({
  mint: stock, venue: "raydium" as const, inMint: stock, outMint: MAINNET_USDC, inAmountRaw: amountRaw, outAmountRaw: usdcRaw,
});

test("vault NAV is USDC plus marked stocks and never the formatted share amount", () => {
  assert.equal(formatVaultShares("9", 6), "0.000009");
  assert.equal(markedVaultNavUsdc([{ mint: MAINNET_USDC, amountRaw: "100000000" }], []), "100");
  assert.equal(markedVaultNavUsdc(
    [{ mint: MAINNET_USDC, amountRaw: "100000000" }, { mint: stock, amountRaw: "2" }],
    [quote("2", "50000000")],
  ), "150");
  assert.equal(markedVaultNavUsdc([{ mint: MAINNET_USDC, amountRaw: "100000000" }, { mint: stock, amountRaw: "2" }], []), null);
  assert.equal(markedVaultNavUsdc([{ mint: MAINNET_USDC, amountRaw: "100000000" }, { mint: stock, amountRaw: "2" }], null), null);
  assert.notEqual(markedVaultNavUsdc(
    [{ mint: MAINNET_USDC, amountRaw: "100000000" }, { mint: stock, amountRaw: "2" }],
    [quote("2", "50000000")],
  ), "0.000009");
});

test("WSOL support and the share mint are not treated as stock marks", () => {
  const holdings = vaultNavHoldings({
    numTokens: 4,
    composition: [
      { mint: pk(MAINNET_USDC), amount: { toString: () => "40000000" } },
      { mint: pk(stock), amount: { toString: () => "1" } },
      { mint: pk(WSOL_MINT), amount: { toString: () => "1000000000" } },
      { mint: pk(mint), amount: { toString: () => "9" } },
    ],
  }, mint);
  assert.deepEqual(holdings, [{ mint: MAINNET_USDC, amountRaw: "40000000" }, { mint: stock, amountRaw: "1" }]);
  assert.equal(markedVaultNavUsdc(holdings!, [quote("1", "10000000")]), "50");
});

test("token-account balances replace a stale zero composition amount", () => {
  const slots = [{ mint: MAINNET_USDC, amountRaw: "0" }, { mint: stock, amountRaw: "0" }];
  const live = holdingsWithVaultBalances(slots, new Map([[stock, 445981n], [MAINNET_USDC, 25000000n]]));
  assert.deepEqual(live, [{ mint: MAINNET_USDC, amountRaw: "25000000" }, { mint: stock, amountRaw: "445981" }]);
  assert.equal(markedVaultNavUsdc(live, [quote("445981", "125000000")]), "150");
  assert.deepEqual(holdingsWithVaultBalances(slots, null), slots);
});

test("a CLMM spot mark prices the stock leg in USDC and never the formatted share count", () => {
  const sqrt = (1n << 64n).toString();
  const oneToken = "100000000";
  assert.equal(clmmSpotUsdcRaw({ mint0: stock, mint1: MAINNET_USDC, sqrtPriceX64: sqrt, stockMint: stock, amountRaw: oneToken }), oneToken);
  assert.equal(clmmSpotUsdcRaw({ mint0: MAINNET_USDC, mint1: stock, sqrtPriceX64: sqrt, stockMint: stock, amountRaw: oneToken }), oneToken);
  assert.equal(clmmSpotUsdcRaw({ mint0: stock, mint1: WSOL_MINT, sqrtPriceX64: sqrt, stockMint: stock, amountRaw: oneToken }), null);
  assert.equal(clmmSpotUsdcRaw({ mint0: stock, mint1: MAINNET_USDC, sqrtPriceX64: "0", stockMint: stock, amountRaw: oneToken }), null);
  const quoteFromSpot = raydiumNavQuote({ mint: stock, amountRaw: "3" }, { mint0: stock, mint1: MAINNET_USDC, sqrtPriceX64: sqrt });
  assert.equal(quoteFromSpot?.outAmountRaw, "3");
  assert.notEqual(quoteFromSpot?.outAmountRaw, formatVaultShares("9", 6));
  const pool = "AwDFvjEPPwdF1YgXV8asNt6LeEFDduinYneCn6mHDAsh";
  assert.deepEqual(installedRaydiumPool({
    mint: pk(stock), amount: { toString: () => "1" },
    oracleAggregator: { numOracles: 2, oracles: [
      { oracleSettings: { oracleType: 0 }, accountsToLoadLutIds: [0], accountsToLoadLutIndices: [0] },
      { oracleSettings: { oracleType: RAYDIUM_ORACLE_KINDS.raydium_clmm }, accountsToLoadLutIds: [0], accountsToLoadLutIndices: [1] },
    ] },
  }, [{ state: { addresses: [pk(mint), pk(pool)] } }]), { pool, kind: "raydium_clmm" });
  assert.equal(installedRaydiumPool({ mint: pk(stock), amount: { toString: () => "1" }, oracleAggregator: { numOracles: 1, oracles: [{ oracleSettings: { oracleType: 0 } }] } }), null);
});

test("a 9/9 Mag7 holder is marked at the full vault NAV, not a dash or 0.000009", async () => {
  const holdings = [{ mint: MAINNET_USDC, amountRaw: "25000000" }, { mint: stock, amountRaw: "3" }];
  const position = attachPositionNav({
    indexId: "idx-theme-mag7-caucus", indexName: "Mag7 Caucus", owner, shareMint: mint,
    shareDecimals: 6, sharesRaw: "9", shareSupplyRaw: "9",
  }, holdings, [quote("3", "125000000")]);
  assert.equal(position.vaultValueUsdc, "150");
  assert.equal(position.markedValueUsdc, "150");
  assert.equal(position.priceBasis, "pro-rata-vault-nav");
  assert.notEqual(position.vaultValueUsdc, formatVaultShares(position.sharesRaw, position.shareDecimals ?? 0));
  const third = attachPositionNav({
    indexId: "idx-theme-mag7-caucus", indexName: "Mag7 Caucus", owner, shareMint: mint,
    shareDecimals: 6, sharesRaw: "3", shareSupplyRaw: "9",
  }, holdings, [quote("3", "125000000")]);
  assert.equal(third.markedValueUsdc, "50");
  const unread = attachPositionNav({
    indexId: "idx-theme-mag7-caucus", indexName: "Mag7 Caucus", owner, shareMint: mint,
    shareDecimals: 6, sharesRaw: "9", shareSupplyRaw: "9",
  }, holdings, null);
  assert.equal(unread.vaultValueUsdc, undefined);
  assert.equal(unread.markedValueUsdc, undefined);
  const one = await handleIndexPosition(request(`/api/indexes/${index().indexId}/position`), index().indexId, {
    getIndex: async () => index(),
    readPosition: async (definition, wallet) => attachPositionNav({
      indexId: definition.indexId, indexName: definition.name, owner: wallet, shareMint: definition.shareMint,
      shareDecimals: 6, sharesRaw: "9", shareSupplyRaw: "9",
    }, holdings, [quote("3", "125000000")]),
  });
  assert.equal(one.status, 200);
  assert.deepEqual(await one.json(), {
    indexId: "idx-theme-mag7-caucus", indexName: "Mag7 Caucus", owner, shareMint: mint,
    shareDecimals: 6, sharesRaw: "9", shareSupplyRaw: "9", vaultValueUsdc: "150", markedValueUsdc: "150",
    priceBasis: "pro-rata-vault-nav",
  });
});
