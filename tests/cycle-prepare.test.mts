import assert from "node:assert/strict";
import { test } from "node:test";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { allSevenVm, definition } from "./support/all-seven-vm.mts";
import { cycleTestPolicy, cycleTestOwner, cycleTestKeeper } from "./support/cycle-policy.mts";
import { localCycleReceipt } from "./support/cycle-receipt-vm.mts";
import { prepareCycleStep } from "../src/lib/index-vaults/cycle-prepare.ts";
import { initialCycleState } from "../src/lib/index-vaults/cycle-store.ts";
import { observeCycle } from "../src/lib/index-vaults/cycle-observer.ts";
import { decodeCycleReceipt } from "../src/lib/index-vaults/cycle-receipts.ts";
import { applyCreditSale } from "../src/lib/index-vaults/cycle-accounting.ts";
import { MAINNET_USDC } from "../src/lib/index-vaults/native-defaults.ts";

test("definition-driven planner emits separate owner/keeper steps against real local programs, then exact-credit exit", async () => {
  const realNow = Date.now;
  try {
    const policy = cycleTestPolicy(), vm = allSevenVm({ owner: policy.owner, keeper: policy.keeper });
    Date.now = vm.now;
    // Synthetic authorization ONLY inside a no-network VM. These are NOT pilot recommendations
    // or captain approvals; no real key, RPC send, production write or wallet is involved.
    policy.expiresAt = vm.now() + 3600000;
    policy.financialExecutionAuthorized = true; policy.approvalReference = "LOCAL-TEST-ONLY-NOT-LIVE-AUTHORITY";
    policy.economics = { keeperSurplus: "native-filler-retains", shareQuantization: "bounded-native-units", residualCash: "native-backing", issuerAuthorityRiskApproved: true, nativeSettlementRiskApproved: true };
    policy.limits.minExitUsdcRaw = "97000000";
    policy.limits.maxOwnerSolDebitLamports = "1000000000"; policy.limits.maxKeeperSolDebitLamports = "1000000000";
    policy.limits.maxKeeperSurplusUsdcRaw = "1000000"; policy.limits.maxBountyRaw = "10000000";
    const record = { ...definition, keeper: { pubkey: policy.keeper, automationEnabled: true } }, state = initialCycleState(policy);
    vm.seed(policy.owner, MAINNET_USDC, 100_000_123n);
    for (const l of record.vaultLegs) vm.seed(policy.owner, l.mint, 123n, TOKEN_2022_PROGRAM_ID);
    const input = { native: vm.native, record, policy, state, metadata: vm.metadata };
    await assert.rejects(prepareCycleStep({ ...input, policy: { ...policy, financialExecutionAuthorized: false }, actor: "owner" }), /EXECUTION_DISABLED/);
    await assert.rejects(prepareCycleStep({ ...input, actor: "owner" }), /KEEPER_SETUP_REQUIRED/);
    const tiny = { ...policy, limits: { ...policy.limits, depositUsdcRaw: "500000" } };
    await assert.rejects(prepareCycleStep({ ...input, policy: tiny, state: initialCycleState(tiny), actor: "keeper" }), /AMOUNT_CANNOT_REPRESENT_MINIMUM_SHARES/);
    async function execute(actor: "owner" | "keeper", expected: string, request: "next" | "withdraw" = "next") {
      const prepared = await prepareCycleStep({ ...input, actor, request });
      assert.equal(prepared.action, expected, prepared.reason); assert(prepared.pending);
      const p = prepared.pending, chain = await observeCycle(vm.native, record, policy, request === "withdraw" || state.phase === "exiting" ? "recovery" : "strict");
      const rpc = await localCycleReceipt(vm, p.txBase64, actor === "owner" ? cycleTestOwner : cycleTestKeeper);
      const receipt = decodeCycleReceipt(rpc, { signature: rpc.transaction.signatures[0], messageHash: p.messageHash, payer: p.payer, owner: policy.owner, vault: policy.vault, shareMint: policy.shareMint, operationId: policy.operationId, minSlot: p.minSlot, mints: chain.mintBindings });
      state.receipts.push({ signature: receipt.signature, messageHash: p.messageHash, action: p.action, slot: receipt.slot, status: "finalized", payer: p.payer, payerDebitLamports: receipt.payerNetDebitLamports.toString() });
      const key = actor === "owner" ? "ownerSolDebitLamports" : "keeperSolDebitLamports";
      state[key] = (BigInt(state[key]) + receipt.payerNetDebitLamports).toString();
      if (p.bounty) state.bountyFundingRaw = (BigInt(state.bountyFundingRaw) + BigInt(p.bounty.fundingRaw)).toString();
      if (p.action === "create") { state.depositGenerationSignature = receipt.signature; state.phase = "investing"; state.nativeClaimsClear = false; }
      if (p.action === "contribute") state.contributedUsdcRaw = (-receipt.tokenDelta(policy.owner, MAINNET_USDC)).toString();
      if (p.action === "mint") state.mintedSharesRaw = receipt.ownerShareDelta.toString();
      if (p.action === "fill") {
        const prices = p.surplusPricesQ!, usdc = BigInt(prices[MAINNET_USDC]);
        const q = record.vaultLegs.reduce((sum, l) => sum + receipt.tokenDelta(policy.keeper, l.mint) * BigInt(prices[l.mint]), 0n);
        state.keeperSurplusUsdcRaw = (BigInt(state.keeperSurplusUsdcRaw) + (q + usdc - 1n) / usdc).toString();
      }
      if (p.action === "cleanup") { state.nativeClaimsClear = true; if (state.phase === "investing") state.phase = "holding"; }
      if (p.action === "withdraw") { state.phase = "exiting"; state.nativeClaimsClear = false; state.exitGenerationSignature = receipt.signature; state.burnedSharesRaw = (-receipt.ownerShareDelta).toString(); }
      if (p.action === "claim") state.credits.push(...receipt.credits);
      if (p.action === "convert") { receipt.assertConversion(p.inputMint!, p.exactInputRaw!, p.minOutputRaw!); applyCreditSale(state.credits, state, p.inputMint!, p.exactInputRaw!); }
      if (p.action === "claim" || p.action === "convert") state.recoveredUsdcRaw = (BigInt(state.recoveredUsdcRaw) + receipt.tokenDelta(policy.owner, MAINNET_USDC)).toString();
      return receipt;
    }
    await execute("keeper", "setup-keeper"); await execute("keeper", "setup-keeper");
    assert.equal((await prepareCycleStep({ ...input, actor: "keeper" })).action, "wait");
    for (const l of record.vaultLegs) vm.seed(policy.keeper, l.mint, 321n, TOKEN_2022_PROGRAM_ID);
    vm.seed(policy.keeper, MAINNET_USDC, 5_000_000n);
    await execute("owner", "create");
    await assert.rejects(prepareCycleStep({ ...input, actor: "owner", request: "withdraw" }), /WITHDRAW_REQUIRES_HELD_SHARES/);
    await execute("owner", "contribute"); await execute("owner", "lock");
    let intent = (await vm.native.sdk.fetchRebalanceIntent(vm.intent)).chain_data;
    vm.time(Number(intent.executionStartTime.toString()));
    for (let n = 0; n < 10; n++) {
      const plan = await prepareCycleStep({ ...input, actor: "keeper" });
      if (plan.action !== "prices") break;
      await execute("keeper", "prices");
    }
    intent = (await vm.native.sdk.fetchRebalanceIntent(vm.intent)).chain_data;
    for (const [n, offset] of [[0, 57], [0, 71], [1, 34], [2, 17]]) {
      vm.time(Number(intent.auctions[n].startTime.toString()) + offset); await execute("keeper", "fill");
    }
    vm.time(Number(intent.auctions[2].endTime.toString()) + 1);
    await execute("keeper", "mint"); await execute("keeper", "cleanup");
    assert.equal((await prepareCycleStep({ ...input, actor: "owner" })).action, "holding");
    await execute("owner", "withdraw", "withdraw");
    for (let n = 0; n < 10; n++) {
      if ((await prepareCycleStep({ ...input, actor: "owner" })).action !== "claim") break;
      await execute("owner", "claim");
    }
    await execute("owner", "cleanup"); // owner recovery does not require a live keeper
    for (let n = 0; n < 7; n++) await execute("owner", "convert");
    assert.equal((await prepareCycleStep({ ...input, actor: "owner" })).action, "complete");
    assert(BigInt(state.recoveredUsdcRaw) >= BigInt(policy.limits.minExitUsdcRaw));
    assert.equal(await vm.balance(policy.owner, MAINNET_USDC), 123n + BigInt(state.recoveredUsdcRaw));
    assert.equal(await vm.balance(policy.keeper, MAINNET_USDC), 5_000_000n);
    for (const l of record.vaultLegs) {
      assert.equal(await vm.balance(policy.owner, l.mint, TOKEN_2022_PROGRAM_ID), 123n);
      assert(await vm.balance(policy.keeper, l.mint, TOKEN_2022_PROGRAM_ID) >= 321n);
    }
    console.log("LOCAL_PLANNER_REPLAY_NOT_LIVE", { minted: state.mintedSharesRaw, recoveredUsdc: state.recoveredUsdcRaw, ownerLamports: state.ownerSolDebitLamports, keeperLamports: state.keeperSolDebitLamports });
  } finally { Date.now = realNow; }
});
