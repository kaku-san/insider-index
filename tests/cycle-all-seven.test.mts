import assert from "node:assert/strict";
import { test } from "node:test";
import { register } from "node:module";
import type { Vault } from "@symmetry-hq/sdk";
import { getSwapPairs } from "@symmetry-hq/sdk/dist/states/intents/rebalanceIntent.js";
import { getVaultFeesPda } from "@symmetry-hq/sdk/dist/instructions/pda.js";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, unpackMint } from "@solana/spl-token";
import { ComputeBudgetProgram } from "@solana/web3.js";
import { allSevenVm, definition, pk } from "./support/all-seven-vm.mts";
import { MAINNET_USDC, NATIVE_DEFAULT_BINDINGS } from "../src/lib/index-vaults/native-defaults.ts";
import { WSOL_MINT } from "../src/lib/index-vaults/raydium-oracles.ts";
import { legBindings } from "../src/lib/index-vaults/keeper-tick.ts";
import { completeKeepTokens } from "../src/lib/index-vaults/symmetry-adapter.ts";
import { buildCycleRoute } from "../src/lib/index-vaults/cycle-routes.ts";
import { buildCycleFillWire } from "../src/lib/index-vaults/cycle-wire.ts";
import { attributeCycleClaim, creditSaleAmount, applyCreditSale, assertCycleBacking, assertMintEffects, fractionRaw } from "../src/lib/index-vaults/cycle-accounting.ts";

register("./support/ui-loader.mjs", import.meta.url);
const { prepareMag7Mint } = await import("../scripts/mag7-settle-deposit.mts");

async function begin(vm: ReturnType<typeof allSevenVm>, amount = 100_000_000n) {
  vm.seed(vm.owner, MAINNET_USDC, amount);
  vm.seed(vm.keeper, MAINNET_USDC, 5_000_000n);
  for (const l of definition.vaultLegs) { vm.seed(vm.owner, l.mint, 123n, TOKEN_2022_PROGRAM_ID); vm.seed(vm.keeper, l.mint, 321n, TOKEN_2022_PROGRAM_ID); }
  vm.apply(await vm.native.sdk.buyVaultTx({ buyer: vm.owner, vault_mint: vm.shareMint, contributions: [{ mint: MAINNET_USDC, amount: Number(amount) }], rebalance_slippage_bps: 100, per_trade_rebalance_slippage_bps: 50 }));
  vm.apply(await vm.native.sdk.lockDepositsTx({ buyer: vm.owner, vault_mint: vm.shareMint }));
  const i = (await vm.native.sdk.fetchRebalanceIntent(vm.intent)).chain_data;
  vm.time(Number(i.executionStartTime.toString()) + 1);
  vm.apply((await vm.native.priceUpdateFromVault(await vm.native.sdk.fetchVault(vm.vault), vm.keeper, vm.intent, [...legBindings(definition.vaultLegs), ...NATIVE_DEFAULT_BINDINGS])).payload);
  return (await vm.native.sdk.fetchRebalanceIntent(vm.intent)).chain_data;
}
async function actualBacking(vm: ReturnType<typeof allSevenVm>) {
  return new Map(await Promise.all([...definition.vaultLegs.map(l => [l.mint, TOKEN_2022_PROGRAM_ID] as const), [MAINNET_USDC, TOKEN_PROGRAM_ID] as const, [WSOL_MINT, TOKEN_PROGRAM_ID] as const].map(async ([m, p]) => [m, await vm.balance(vm.vault, m, p)] as const)));
}

test("all seven persisted >$10k pools: bounded DEX fills in native auction windows, mint, interrupted claim, exact-credit USDC exits", async () => {
  const realNow = Date.now, realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("NETWORK_FORBIDDEN"); };
  try {
    const vm = allSevenVm(); Date.now = vm.now;
    const initial = await begin(vm), filled = new Set(), mintBefore = await vm.native.sdk.fetchVault(vm.vault);
    // Two-leg atomic batches; 14 simulated seconds between the first two finalizations.
    // Later native windows last only 50/25 seconds. No claim that live RPC/landing timing
    // is guaranteed: missed windows must recover, not mint a silently incomplete book.
    for (const [auction, offset] of [[0, 57], [0, 71], [1, 34], [2, 17]]) {
      vm.time(Number(initial.auctions[auction].startTime.toString()) + offset);
      const i = (await vm.native.sdk.fetchRebalanceIntent(vm.intent)).chain_data;
      const candidates = getSwapPairs(i, await vm.native.sdk.fetchVault(vm.vault)).filter(p => p.outMint === MAINNET_USDC && !filled.has(p.inMint));
      const fills = [], pairs = [];
      for (const pair of candidates) {
        const leg = definition.vaultLegs.find(l => l.mint === pair.inMint); assert(leg);
        let route;
        try { route = await buildCycleRoute({ connection: vm.connection, leg, owner: vm.keeper, inputMint: MAINNET_USDC, outputMint: leg.mint, amountInRaw: String(pair.outAmount), minimumOutRaw: String(pair.inAmount), slippageBps: 50, maxAgeMs: 60000, metadata: vm.metadata, now: vm.now }); }
        catch (error) { if (error instanceof Error && error.message === "CYCLE_ROUTE_MINIMUM_UNSATISFIABLE") continue; throw error; }
        assert(route.tvlUsd >= 10000); assert.equal(route.pool, leg.pool);
        fills.push({ route, maxRepaymentRaw: String(pair.inAmount) }); pairs.push(pair);
        if (fills.length === 2) break;
      }
      assert(pairs.length > 0);
      const wire = await buildCycleFillWire({ native: vm.native, keeper: vm.keeper, vault: vm.vault, intent: vm.intent, fills, computeUnits: 1_400_000, microLamports: "0", maxPriorityFeeLamports: "0" });
      vm.apply({ batches: [{ transactions: [{ tx_b64: wire.txBase64 }] }] });
      for (const pair of pairs) filled.add(pair.inMint);
      assert.equal(await vm.balance(vm.keeper, MAINNET_USDC), 5_000_000n);
      for (const l of definition.vaultLegs) assert(await vm.balance(vm.keeper, l.mint, TOKEN_2022_PROGRAM_ID) >= 321n, "never subsidize execution with preexisting keeper stocks");
      assertCycleBacking(await vm.native.sdk.fetchVault(vm.vault), [await vm.native.sdk.fetchRebalanceIntent(vm.intent)], await actualBacking(vm));
      // A repeated attempt is rejected or re-derived; native filled targets are not spent twice.
    }
    assert.equal(filled.size, 7);
    const beforeMint = (await vm.native.sdk.fetchRebalanceIntent(vm.intent)).chain_data;
    vm.time(Number(initial.auctions[2].endTime.toString()) + 1);
    // This legacy fixture buys every name only once. Later target refreshes leave
    // some legs below target. That partial book still mints; an empty book would not.
    const prepared = await prepareMag7Mint({ investmentLegMints: definition.vaultLegs.map(leg => leg.mint),
      tokens: beforeMint.tokens.map(token => ({ mint: token.mint.toBase58(), amount: token.amount.toString(), targetAmount: token.targetAmount.toString() })), wsolMint: WSOL_MINT },
    () => vm.native.sdk.mintTx({ keeper: vm.keeper, rebalance_intent: vm.intent }));
    const atTarget = definition.vaultLegs.every(leg => {
      const token = beforeMint.tokens.find(item => item.mint.toBase58() === leg.mint);
      return Boolean(token && BigInt(token.targetAmount.toString()) > 0n && BigInt(token.amount.toString()) >= BigInt(token.targetAmount.toString()));
    });
    assert.equal(atTarget, false);
    assert.equal(prepared.plan.mayMint, true);
    assert.ok(prepared.plan.filledLegMints.length > 0);
    vm.apply(prepared.payload);
    const minted = await vm.balance(vm.owner, vm.shareMint), vault = await vm.native.sdk.fetchVault(vm.vault);
    assert(minted > 0n);
    const mint = unpackMint(pk(vm.shareMint), await vm.connection.getAccountInfo(pk(vm.shareMint)), TOKEN_PROGRAM_ID);
    const fees = await vm.balance(getVaultFeesPda(pk(vm.vault)).toBase58(), vm.shareMint);
    const prices = new Map(beforeMint.tokens.map(t => [t.mint.toBase58(), fractionRaw(t.price.price)]));
    const value = (v: Vault) => v.composition.slice(0, v.numTokens).reduce((sum, t) => sum + BigInt(t.amount.toString()) * (prices.get(t.mint.toBase58()) ?? 0n), 0n);
    assertMintEffects({ beforeSupply: "0", afterSupply: mint.supply.toString(), beforeOutstanding: "0", afterOutstanding: vault.supplyOutstanding.toString(), ownerShareDelta: minted.toString(), feeShareDelta: fees.toString(), feeAccrualDelta: Object.values(vault.accumulatedFees).reduce((s, v) => s + BigInt(v.toString()), 0n).toString(), minNetSharesRaw: "1", beforeValueQ: value(mintBefore), contributedValueQ: value(vault) - value(mintBefore), usdcPriceQ: prices.get(MAINNET_USDC)!, maxRoundingLossUsdcRaw: "0" });
    assert.equal(vault.settings.fees.hostDepositFeeBps, 25); assert.equal(vault.settings.fees.hostWithdrawFeeBps, 0);
    assertCycleBacking(vault, [await vm.native.sdk.fetchRebalanceIntent(vm.intent)], await actualBacking(vm));
    vm.seed(vm.keeper, WSOL_MINT, 0n); vm.time(Number(vm.svm.getClock().unixTimestamp) + 1);
    vm.apply(await vm.native.sdk.claimBountyTx({ keeper: vm.keeper, rebalance_intent: vm.intent }));
    vm.apply(await vm.native.sdk.sellVaultTx({ seller: vm.owner, vault_mint: vm.shareMint, withdraw_amount: Number(minted), keep_tokens: completeKeepTokens(vault), rebalance_slippage_bps: 100, per_trade_rebalance_slippage_bps: 50 }));
    assert.equal(await vm.balance(vm.owner, vm.shareMint), 0n);
    const binding = { owner: vm.owner, vault: vm.vault, operationId: "00000000-0000-4000-8000-000000000001" }, credits = [];
    const programs = new Map([...definition.vaultLegs.map(l => [l.mint, TOKEN_2022_PROGRAM_ID.toBase58()] as const), [MAINNET_USDC, TOKEN_PROGRAM_ID.toBase58()] as const, [WSOL_MINT, TOKEN_PROGRAM_ID.toBase58()] as const]);
    const claim = async () => new Map((await vm.native.sdk.fetchRebalanceIntent(vm.intent)).chain_data.tokens.map(t => [t.mint.toBase58(), BigInt(t.amount.toString())]));
    const wallet = async () => new Map(await Promise.all([...programs].map(async ([m, p]) => [m, await vm.balance(vm.owner, m, pk(p))] as const)));
    // Simulated interruption after every batch; each resume re-reads the remaining native claim.
    for (let n = 0; n < 10; n++) {
      const beforeClaim = await claim(), beforeWallet = await wallet();
      const payload = await vm.native.sdk.redeemTokensTx({ keeper: vm.owner, rebalance_intent: vm.intent });
      const tx = payload.batches.flatMap(b => b.transactions)[0]; if (!tx) break;
      vm.apply({ batches: [{ transactions: [tx] }] });
      credits.push(...attributeCycleClaim({ ...binding, signature: `local-unsigned-simulation-${n}`, instructionIndex: 0, beforeClaim, afterClaim: await claim(), beforeWallet, afterWallet: await wallet(), programs }));
    }
    assert.equal((await vm.native.sdk.redeemTokensTx({ keeper: vm.owner, rebalance_intent: vm.intent })).batches.flatMap(b => b.transactions).length, 0);
    let minimumTotal = await vm.balance(vm.owner, MAINNET_USDC);
    for (const leg of definition.vaultLegs) {
      const amount = creditSaleAmount(credits, binding, leg.mint); assert(amount > 0n);
      const route = await buildCycleRoute({ connection: vm.connection, leg, owner: vm.owner, inputMint: leg.mint, outputMint: MAINNET_USDC, amountInRaw: amount.toString(), slippageBps: 50, maxAgeMs: 60000, metadata: vm.metadata, now: vm.now });
      const before = await vm.balance(vm.owner, MAINNET_USDC), beforeStock = await vm.balance(vm.owner, leg.mint, TOKEN_2022_PROGRAM_ID);
      vm.apply({ batches: [{ transactions: [{ tx_b64: vm.wire([ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }), route.instruction]) }] }] });
      assert.equal(beforeStock - await vm.balance(vm.owner, leg.mint, TOKEN_2022_PROGRAM_ID), amount);
      assert(await vm.balance(vm.owner, MAINNET_USDC) - before >= BigInt(route.minOutRaw));
      minimumTotal += BigInt(route.minOutRaw); applyCreditSale(credits, binding, leg.mint, amount.toString());
      assert.equal(creditSaleAmount(credits, binding, leg.mint), 0n);
      assert.equal(await vm.balance(vm.owner, leg.mint, TOKEN_2022_PROGRAM_ID), 123n, "unrelated stock preserved");
    }
    const returned = await vm.balance(vm.owner, MAINNET_USDC);
    assert(returned >= minimumTotal && returned < 100_000_000n, "costs are real, not a lossless-cycle promise");
    console.log("LOCAL_MIXED_SLOT_ROUNDTRIP", { contributedUsdcRaw: "100000000", mintedSharesRaw: minted.toString(), feeSharesRaw: fees.toString(), returnedUsdcRaw: returned.toString(), quotedExitMinimumRaw: minimumTotal.toString() });
    assertCycleBacking(await vm.native.sdk.fetchVault(vm.vault), [await vm.native.sdk.fetchRebalanceIntent(vm.intent)], await actualBacking(vm));
  } finally { Date.now = realNow; globalThis.fetch = realFetch; }
});
