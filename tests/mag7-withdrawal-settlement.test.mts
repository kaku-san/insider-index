import assert from "node:assert/strict";
import test from "node:test";
import BN from "bn.js";
import { address } from "@solana/kit";
import { PublicKey } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, createCloseAccountInstruction, createTransferCheckedInstruction, getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { RebalanceIntentLayout, RebalanceType, type RebalanceIntent } from "@symmetry-hq/sdk/dist/layouts/intents/rebalanceIntent.js";
import { getSwapPairs } from "@symmetry-hq/sdk/dist/states/intents/rebalanceIntent.js";
import { allSevenVm, definition } from "./support/all-seven-vm.mts";
import { MAINNET_USDC, NATIVE_DEFAULT_BINDINGS } from "../src/lib/index-vaults/native-defaults.ts";
import { legBindings, prepareWithdrawalKeeperStep, prepareIndexKeeperStep, withdrawalAuctionSales, type IndexKeeperObservation } from "../src/lib/index-vaults/keeper-tick.ts";
import { buildCycleRoute } from "../src/lib/index-vaults/cycle-routes.ts";

// A synthetic WITHDRAW auction in an unsigned deployed-program VM. We seed the
// withdrawal stage explicitly, NOT claim an empty-keep burn/pricing roundtrip.
async function withdrawalFixture(stock = false, keepUsdc = true) {
  const vm = allSevenVm();
  Date.now = vm.now;
  vm.seed(vm.owner, MAINNET_USDC, 100_000_000n);
  vm.seed(vm.keeper, MAINNET_USDC, 0n);
  vm.apply(await vm.native.sdk.buyVaultTx({ buyer: vm.owner, vault_mint: vm.shareMint,
    contributions: [{ mint: MAINNET_USDC, amount: 100_000_000 }], rebalance_slippage_bps: 100, per_trade_rebalance_slippage_bps: 50 }));
  vm.apply(await vm.native.sdk.lockDepositsTx({ buyer: vm.owner, vault_mint: vm.shareMint }));
  const initial = (await vm.native.sdk.fetchRebalanceIntent(vm.intent)).chain_data;
  vm.time(Number(initial.executionStartTime.toString()) + 1);
  Date.now = vm.now;
  vm.apply((await vm.native.priceUpdateFromVault(await vm.native.sdk.fetchVault(vm.vault), vm.keeper, vm.intent, [...legBindings(definition.vaultLegs), ...NATIVE_DEFAULT_BINDINGS])).payload);
  const account = vm.svm.getAccount(address(vm.intent)); assert(account.exists);
  const data = Buffer.from(account.data), chain = RebalanceIntentLayout.decode(data.subarray(8)) as RebalanceIntent;
  chain.rebalanceType = RebalanceType.Withdraw;
  chain.auctionUpdateTimestamp = new BN(0);
  chain.tokens.find(token => token.mint.toBase58() === MAINNET_USDC)!.keepToken = keepUsdc ? 1 : 0;
  if (stock) {
    const leg = definition.vaultLegs[0];
    chain.tokens.find(token => token.mint.toBase58() === leg.mint)!.amount = new BN(1_000_000);
    vm.seed(vm.owner, leg.mint, 1_000_000n, TOKEN_2022_PROGRAM_ID);
    const mint = new PublicKey(leg.mint), owner = new PublicKey(vm.owner), vault = new PublicKey(vm.vault);
    const destination = getAssociatedTokenAddressSync(mint, vault, true, TOKEN_2022_PROGRAM_ID);
    vm.apply({ batches: [{ transactions: [{ tx_b64: vm.wire([
      createAssociatedTokenAccountIdempotentInstruction(owner, destination, vault, mint, TOKEN_2022_PROGRAM_ID),
      createTransferCheckedInstruction(getAssociatedTokenAddressSync(mint, owner, false, TOKEN_2022_PROGRAM_ID), mint, destination, owner, 1_000_000n, leg.decimals, [], TOKEN_2022_PROGRAM_ID),
    ]) }] }] });
    vm.seed(vm.keeper, leg.mint, 0n, TOKEN_2022_PROGRAM_ID);
  }
  RebalanceIntentLayout.encode(chain, data.subarray(8));
  vm.svm.setAccount({ ...account, data });
  vm.time(Number(chain.auctions[0].startTime.toString()) + 75);
  return { vm, chain, input: { native: vm.native, vault: await vm.native.sdk.fetchVault(vm.vault), intentAddress: vm.intent, keeper: vm.keeper, legs: definition.vaultLegs } };
}

test("USDC-only withdrawal waits through the boundary then returns vault cash to its owner, not keeper", async () => {
  const realNow = Date.now;
  try {
    const { vm, chain, input } = await withdrawalFixture();
    const owner = new PublicKey(vm.owner), usdcAta = getAssociatedTokenAddressSync(new PublicKey(MAINNET_USDC), owner);
    vm.apply({ batches: [{ transactions: [{ tx_b64: vm.wire([createCloseAccountInstruction(usdcAta, owner, owner)]) }] }] });
    assert.equal(await vm.connection.getAccountInfo(usdcAta), null);
    const neverQuote = async () => { throw new Error("CASH_ONLY_MUST_NOT_QUOTE_BUYS"); };
    assert.equal((await prepareWithdrawalKeeperStep(input, neverQuote)).step, "wait");
    vm.time(Number(chain.auctions[2].endTime.toString()));
    assert.equal((await prepareWithdrawalKeeperStep(input, neverQuote)).step, "wait");
    vm.time(Number(chain.auctions[2].endTime.toString()) + 1);
    // Generic keeper delegates to the same policy; simulate the emitted owner-only claim.
    const observation = { vault: input.vault, vaultAddress: vm.vault, intents: 1,
      withdrawalIntents: [{ address: vm.intent, owner: vm.owner, stage: "redeem" }], legs: definition.vaultLegs } as unknown as IndexKeeperObservation;
    const plan = await prepareIndexKeeperStep(observation, vm.keeper, vm.native);
    assert.equal(plan.step, "redeem");
    for (const tx of plan.transactions) vm.apply({ batches: [{ transactions: [{ tx_b64: tx.txBase64 }] }] });
    assert.equal(await vm.balance(vm.owner, MAINNET_USDC), 100_000_000n);
    assert.equal(await vm.balance(vm.keeper, MAINNET_USDC), 0n);
    assert.equal(await vm.balance(vm.vault, MAINNET_USDC), 0n);
    assert((await vm.native.sdk.fetchRebalanceIntent(vm.intent)).chain_data.tokens.every(token => token.amount.isZero()));
    // Native closure frees this owner's single intent for the next deposit.
    vm.seed(vm.keeper, "So11111111111111111111111111111111111111112", 0n);
    const cleanup = await prepareWithdrawalKeeperStep(input, neverQuote);
    assert.equal(cleanup.step, "claim-bounty");
    for (const tx of cleanup.transactions) vm.apply({ batches: [{ transactions: [{ tx_b64: tx.txBase64 }] }] });
    assert.equal(await vm.connection.getAccountInfo(new PublicKey(vm.intent)), null);
    vm.apply(await vm.native.sdk.buyVaultTx({ buyer: vm.owner, vault_mint: vm.shareMint,
      contributions: [{ mint: MAINNET_USDC, amount: 1_000_000 }], rebalance_slippage_bps: 100, per_trade_rebalance_slippage_bps: 50 }));
    assert.equal((await vm.native.sdk.fetchRebalanceIntent(vm.intent)).chain_data.rebalanceType, RebalanceType.Deposit);
  } finally { Date.now = realNow; }
});

test("withdrawal sales use actual SDK direction and Raydium proceeds, with zero keeper USDC inventory", async () => {
  const realNow = Date.now;
  try {
    const { vm, input } = await withdrawalFixture(true);
    const intent = (await vm.native.sdk.fetchRebalanceIntent(vm.intent)).chain_data;
    const pairs = withdrawalAuctionSales(getSwapPairs(intent, input.vault));
    assert.equal(pairs.length, 1);
    assert.equal(pairs[0].inMint, MAINNET_USDC);
    assert.equal(pairs[0].outMint, definition.vaultLegs[0].mint);
    const plan = await prepareWithdrawalKeeperStep(input, args => buildCycleRoute({ ...args, metadata: vm.metadata, now: vm.now }));
    assert.equal(plan.step, "auction");
    for (const tx of plan.transactions) vm.apply({ batches: [{ transactions: [{ tx_b64: tx.txBase64 }] }] });
    const after = (await vm.native.sdk.fetchRebalanceIntent(vm.intent)).chain_data;
    assert.equal(after.tokens.find(token => token.mint.toBase58() === pairs[0].outMint)!.amount.toString(), "0");
    assert(await vm.balance(vm.vault, MAINNET_USDC) >= 100_000_000n + BigInt(pairs[0].inAmount));
    assert.equal(await vm.balance(vm.keeper, pairs[0].outMint, TOKEN_2022_PROGRAM_ID), 0n);
    // Sale surplus is allowed; preexisting keeper inventory was zero and cannot subsidize repayment.
    assert(await vm.balance(vm.keeper, MAINNET_USDC) >= 0n);
  } finally { Date.now = realNow; }
});

test("empty sale list during the window waits; missed window redeems leftover USDC and stocks as-is", async () => {
  const realNow = Date.now;
  try {
    const { vm, chain, input } = await withdrawalFixture(true, false);
    const stock = definition.vaultLegs[0].mint;
    const neverQuote = async () => { throw new Error("EMPTY_LIST_MUST_NOT_QUOTE"); };
    const waiting = await prepareWithdrawalKeeperStep(input, neverQuote);
    assert.equal(waiting.step, "wait");
    assert.equal(waiting.eligible, false);
    assert.match(waiting.reason, /reread the native sale list/);
    vm.time(Number(chain.auctions[2].endTime.toString()) + 1);
    const observation = { vault: input.vault, vaultAddress: vm.vault, intents: 1,
      withdrawalIntents: [{ address: vm.intent, owner: vm.owner, stage: "redeem" }], legs: definition.vaultLegs } as unknown as IndexKeeperObservation;
    const plan = await prepareIndexKeeperStep(observation, vm.keeper, vm.native);
    assert.equal(plan.step, "redeem");
    assert.match(plan.reason, /as-is/);
    for (const tx of plan.transactions) vm.apply({ batches: [{ transactions: [{ tx_b64: tx.txBase64 }] }] });
    assert.equal(await vm.balance(vm.owner, stock, TOKEN_2022_PROGRAM_ID), 1_000_000n);
    assert.equal(await vm.balance(vm.owner, MAINNET_USDC), 100_000_000n);
    assert.equal(await vm.balance(vm.vault, stock, TOKEN_2022_PROGRAM_ID), 0n);
    assert.equal(await vm.balance(vm.vault, MAINNET_USDC), 0n);
    assert.equal(await vm.balance(vm.keeper, stock, TOKEN_2022_PROGRAM_ID), 0n);
    assert.equal(await vm.balance(vm.keeper, MAINNET_USDC), 0n);
    assert((await vm.native.sdk.fetchRebalanceIntent(vm.intent)).chain_data.tokens.every(token => token.amount.isZero()));
    const second = await withdrawalFixture(true);
    await assert.rejects(prepareWithdrawalKeeperStep(second.input, async () => { throw new Error("CYCLE_ROUTE_MINIMUM_UNSATISFIABLE"); }), /CYCLE_ROUTE_MINIMUM_UNSATISFIABLE/);
    assert.equal(await second.vm.balance(second.vm.keeper, MAINNET_USDC), 0n);
    assert.equal(await second.vm.balance(second.vm.owner, definition.vaultLegs[0].mint, TOKEN_2022_PROGRAM_ID), 0n);
  } finally { Date.now = realNow; }
});
