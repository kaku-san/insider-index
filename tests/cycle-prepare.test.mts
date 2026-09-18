import assert from "node:assert/strict";
import { test } from "node:test";
import bs58 from "bs58";
import { VersionedTransaction, type VersionedTransactionResponse } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { allSevenVm, definition } from "./support/all-seven-vm.mts";
import { cycleTestPolicy, cycleTestOwner, cycleTestKeeper } from "./support/cycle-policy.mts";
import { localCycleReceipt } from "./support/cycle-receipt-vm.mts";
import { prepareCycleStep } from "../src/lib/index-vaults/cycle-prepare.ts";
import { cycleDb } from "./support/cycle-db.mts";
import { CycleRunner } from "../src/lib/index-vaults/cycle-runner.ts";
import { initialCycleState, CycleJournal } from "../src/lib/index-vaults/cycle-store.ts";
import { observeCycle } from "../src/lib/index-vaults/cycle-observer.ts";
import { decodeCycleReceipt } from "../src/lib/index-vaults/cycle-receipts.ts";
import { MAINNET_USDC } from "../src/lib/index-vaults/native-defaults.ts";

test("durable definition-driven controller executes separate owner/keeper steps against local programs, then exact-credit exit", async () => {
  const realNow = Date.now;
  let database: Awaited<ReturnType<typeof cycleDb>> | undefined;
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
    const record = { ...definition, keeper: { pubkey: policy.keeper, automationEnabled: true } };
    policy.feeScheduleHash = (await observeCycle(vm.native, record, policy)).feeScheduleHash;
    const state = initialCycleState(policy);
    vm.seed(policy.owner, MAINNET_USDC, 100_000_123n);
    for (const l of record.vaultLegs) vm.seed(policy.owner, l.mint, 123n, TOKEN_2022_PROGRAM_ID);
    const input = { native: vm.native, record, policy, state, metadata: vm.metadata };
    database = await cycleDb();
    const journal = new CycleJournal(policy, database.rpc);
    const runner = new CycleRunner({ native: vm.native, policy, journal, loadDefinition: async () => record, metadata: vm.metadata });
    const transactions = new Map<string, VersionedTransactionResponse>();
    vm.connection.getTransaction = (async (signature: string) => transactions.get(signature) ?? null) as typeof vm.connection.getTransaction;
    vm.connection.getSignatureStatuses = async signatures => ({ context: { slot: Number(vm.svm.getClock().slot) }, value: signatures.map(s => transactions.has(s) ? { slot: transactions.get(s)!.slot, confirmations: null, err: null, confirmationStatus: "finalized" } : null) });
    vm.connection.getBlockHeight = async () => Number(vm.svm.getClock().slot);
    vm.connection.sendRawTransaction = async bytes => {
      const encoded = Buffer.from(bytes).toString("base64"), tx = VersionedTransaction.deserialize(Buffer.from(bytes)), signature = bs58.encode(tx.signatures[0]);
      assert.equal((await journal.read()).pending!.signedTransaction, encoded, "durable latch precedes every local relay");
      const signer = tx.message.staticAccountKeys[0].toBase58() === policy.owner ? cycleTestOwner : cycleTestKeeper;
      transactions.set(signature, await localCycleReceipt(vm, encoded, signer));
      return signature;
    };
    await assert.rejects(prepareCycleStep({ ...input, policy: { ...policy, financialExecutionAuthorized: false }, actor: "owner" }), /EXECUTION_DISABLED/);
    await assert.rejects(prepareCycleStep({ ...input, actor: "owner" }), /KEEPER_SETUP_REQUIRED/);
    const tiny = { ...policy, limits: { ...policy.limits, depositUsdcRaw: "500000" } };
    await assert.rejects(prepareCycleStep({ ...input, policy: tiny, state: initialCycleState(tiny), actor: "keeper" }), /AMOUNT_CANNOT_REPRESENT_MINIMUM_SHARES/);
    async function execute(actor: "owner" | "keeper", expected: string, request: "next" | "withdraw" = "next") {
      const prepared = await runner.prepare(actor, request);
      assert.equal(prepared.action, expected, prepared.reason); assert(prepared.pending);
      const p = prepared.pending, chain = await observeCycle(vm.native, record, policy, request === "withdraw" || state.phase === "exiting" ? "recovery" : "strict");
      const signer = actor === "owner" ? cycleTestOwner : cycleTestKeeper, signed = VersionedTransaction.deserialize(Buffer.from(p.txBase64, "base64")); signed.sign([signer]);
      const submitted = await runner.submit(actor, Buffer.from(signed.serialize()).toString("base64"));
      const rpc = transactions.get(submitted.signature)!;
      assert.equal(rpc.transaction.signatures[0], bs58.encode(signed.signatures[0]));
      const receipt = decodeCycleReceipt(rpc, { signature: rpc.transaction.signatures[0], messageHash: p.messageHash, payer: p.payer, owner: policy.owner, vault: policy.vault, shareMint: policy.shareMint, operationId: policy.operationId, minSlot: p.minSlot, mints: chain.mintBindings });
      Object.assign(state, await runner.reconcile());
      assert.equal(state.recoveryRequired, null);
      assert.equal(state.pending, null);
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
    assert.equal((await runner.prepare("owner")).action, "complete");
    assert.equal((await journal.read()).phase, "complete");
    assert(BigInt(state.recoveredUsdcRaw) >= BigInt(policy.limits.minExitUsdcRaw));
    assert.equal(await vm.balance(policy.owner, MAINNET_USDC), 123n + BigInt(state.recoveredUsdcRaw));
    assert.equal(await vm.balance(policy.keeper, MAINNET_USDC), 5_000_000n);
    for (const l of record.vaultLegs) {
      assert.equal(await vm.balance(policy.owner, l.mint, TOKEN_2022_PROGRAM_ID), 123n);
      assert(await vm.balance(policy.keeper, l.mint, TOKEN_2022_PROGRAM_ID) >= 321n);
    }
    console.log("LOCAL_CONTROLLER_REPLAY_NOT_LIVE", { minted: state.mintedSharesRaw, recoveredUsdc: state.recoveredUsdcRaw, ownerLamports: state.ownerSolDebitLamports, keeperLamports: state.keeperSolDebitLamports });
  } finally { Date.now = realNow; await database?.close(); }
});
