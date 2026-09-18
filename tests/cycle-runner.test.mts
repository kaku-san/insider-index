import test from "node:test";
import assert from "node:assert/strict";
import bs58 from "bs58";
import { VersionedTransaction, type VersionedTransactionResponse } from "@solana/web3.js";
import { allSevenVm, definition } from "./support/all-seven-vm.mts";
import { cycleTestPolicy, cycleTestOwner, cycleTestKeeper } from "./support/cycle-policy.mts";
import { localCycleReceipt } from "./support/cycle-receipt-vm.mts";
import { cycleDb } from "./support/cycle-db.mts";
import { sha256 } from "../src/lib/index-vaults/amounts.ts";
import { CycleJournal, bindCycleSubmission } from "../src/lib/index-vaults/cycle-store.ts";
import { MAINNET_USDC } from "../src/lib/index-vaults/native-defaults.ts";
import { CycleRunner } from "../src/lib/index-vaults/cycle-runner.ts";
import { observeCycle } from "../src/lib/index-vaults/cycle-observer.ts";

async function fixture() {
  const policy = cycleTestPolicy(), vm = allSevenVm({ owner: policy.owner, keeper: policy.keeper });
  Object.assign(policy, { financialExecutionAuthorized: true, approvalReference: "LOCAL-TEST-ONLY-NOT-LIVE-AUTHORITY", expiresAt: vm.now() + 3_600_000 });
  Object.assign(policy.limits, { minExitUsdcRaw: "97000000", maxOwnerSolDebitLamports: "1000000000", maxKeeperSolDebitLamports: "1000000000", maxKeeperSurplusUsdcRaw: "1000000", maxBountyRaw: "10000000" });
  policy.economics = { keeperSurplus: "native-filler-retains", shareQuantization: "bounded-native-units", residualCash: "native-backing", issuerAuthorityRiskApproved: true, nativeSettlementRiskApproved: true };
  const record = { ...definition, keeper: { pubkey: policy.keeper, automationEnabled: true } };
  const clock = Date.now; Date.now = vm.now;
  try { policy.feeScheduleHash = (await observeCycle(vm.native, record, policy)).feeScheduleHash; } finally { Date.now = clock; }
  const db = await cycleDb(), journal = new CycleJournal(policy, db.rpc);
  const runner = () => new CycleRunner({ native: vm.native, policy, journal, loadDefinition: async () => record, metadata: vm.metadata });
  const transactions = new Map<string, VersionedTransactionResponse>();
  vm.connection.getTransaction = (async (signature: string) => transactions.get(signature) ?? null) as typeof vm.connection.getTransaction;
  vm.connection.getSignatureStatuses = async signatures => ({ context: { slot: Number(vm.svm.getClock().slot) }, value: signatures.map(s => transactions.has(s) ? { slot: transactions.get(s)!.slot, confirmations: null, err: null, confirmationStatus: "finalized" } : null) });
  vm.connection.getBlockHeight = async () => Number(vm.svm.getClock().slot);
  vm.connection.sendRawTransaction = async bytes => {
    const encoded = Buffer.from(bytes).toString("base64"), tx = VersionedTransaction.deserialize(Buffer.from(bytes)), signature = bs58.encode(tx.signatures[0]);
    assert.equal((await journal.read()).pending!.signedTransaction, encoded);
    const signer = tx.message.staticAccountKeys[0].toBase58() === policy.owner ? cycleTestOwner : cycleTestKeeper;
    transactions.set(signature, await localCycleReceipt(vm, encoded, signer));
    return signature;
  };
  return { vm, policy, record, db, journal, runner, transactions };
}

test("durable controller survives ambiguous relay/restart, accounts finalized fees once and reads during authorization shutdown", async () => {
  const f = await fixture(), clock = Date.now; Date.now = f.vm.now;
  try {
    let sends = 0;
    f.vm.connection.sendRawTransaction = async bytes => {
      const encoded = Buffer.from(bytes).toString("base64"), tx = VersionedTransaction.deserialize(Buffer.from(bytes)), signature = bs58.encode(tx.signatures[0]);
      const saved = await f.journal.read();
      assert.equal(saved.pending!.signature, signature, "the signed attempt was COMMITTED before relay");
      assert.equal(saved.pending!.signedTransaction, encoded);
      sends++;
      const receipt = await localCycleReceipt(f.vm, encoded, cycleTestKeeper); f.transactions.set(signature, receipt);
      throw new Error("SIMULATED_RPC_TIMEOUT_AFTER_LOCAL_APPLY");
    };
    const prepared = await f.runner().prepare("keeper"), p = prepared.pending!;
    assert.equal(p.action, "setup-keeper");
    const tx = VersionedTransaction.deserialize(Buffer.from(p.txBase64, "base64")); tx.sign([cycleTestKeeper]); const wire = Buffer.from(tx.serialize()).toString("base64");
    await assert.rejects(f.runner().submit("owner", wire), /SIGNATURE|PAYER|SIGNER/i);
    await assert.rejects(f.runner().submit("keeper", wire), /SIMULATED_RPC_TIMEOUT_AFTER_LOCAL_APPLY/);
    assert.equal((await f.journal.read()).pending!.signedTransaction, wire);
    await f.runner().submit("keeper", wire); assert.equal(sends, 1, "a known landed signature is not sent again");
    const resumed = await f.runner().reconcile();
    assert.equal(resumed.receipts.length, 1); assert.equal(resumed.pending, null);
    assert.ok(BigInt(resumed.keeperSolDebitLamports) > 0n); assert.equal(resumed.ownerSolDebitLamports, "0");
    await f.runner().submit("keeper", wire); await f.runner().reconcile();
    assert.equal(sends, 1); assert.equal((await f.journal.read()).receipts.length, 1);
    const disabled = { ...f.policy, financialExecutionAuthorized: false };
    const stopped = new CycleRunner({ native: f.vm.native, policy: disabled, journal: new CycleJournal(disabled, f.db.rpc), loadDefinition: async () => f.record, metadata: f.vm.metadata });
    assert.equal((await stopped.reconcile()).receipts.length, 1, "shutdown does not erase finalized recovery history");
    await assert.rejects(stopped.prepare("keeper"), /EXECUTION_DISABLED/);
  } finally { Date.now = clock; await f.db.close(); }
});

test("expiry requires canonical complete finalized history, not a null transaction or wall-clock deadline", async () => {
  for (const signed of [false, true]) {
  const f = await fixture(), clock = Date.now; Date.now = f.vm.now;
  try {
    const prepared = await f.runner().prepare("keeper"), p = prepared.pending!;
    if (signed) {
      const tx = VersionedTransaction.deserialize(Buffer.from(p.txBase64, "base64")); tx.sign([cycleTestKeeper]);
      await f.journal.update(state => bindCycleSubmission(state, Buffer.from(tx.serialize()).toString("base64")));
    }
    // Synthetic RPC ledger/header fixtures, NOT a mainnet expiry proof or altered production TTL.
    // Exercise the full recorded 150-block window; no transaction is ever applied/sent here.
    f.vm.connection.getBlockHeight = async () => p.lastValidBlockHeight + 2;
    f.vm.connection.getSlot = async () => p.minSlot + 200;
    f.vm.connection.isBlockhashValid = async () => ({ context: { slot: p.minSlot + 200 }, value: false });
    f.vm.connection.getFirstAvailableBlock = async () => p.minSlot + 1;
    await assert.rejects(f.runner().reconcile(), /HISTORY_PRUNED/);
    assert.ok((await f.journal.read()).pending);
    f.vm.connection.getFirstAvailableBlock = async () => 0;
    f.vm.connection.getBlocks = async (start, end) => Array.from({ length: Math.min(2, (end ?? start) - start + 1) }, (_, i) => start + i);
    let gap = true;
    const hash = (slot: number) => slot === p.minSlot ? p.blockhash : bs58.encode(Buffer.from(sha256(Buffer.from(`SYNTHETIC-EXPIRY-FIXTURE-${slot}`)), "hex"));
    f.vm.connection.getBlock = (async (slot: number) => ({ blockhash: hash(slot), previousBlockhash: hash(slot - 1), parentSlot: slot - 1, blockHeight: slot + (gap && slot > p.minSlot ? 1 : 0), blockTime: null, transactions: [] })) as typeof f.vm.connection.getBlock;
    await assert.rejects(f.runner().reconcile(), /HISTORY_GAP/);
    assert.equal((await f.journal.read()).pending!.expiryScan, undefined, "failed journal callback does not partially advance its proof");
    gap = false;
    for (let n = 0; n < 100 && (await f.journal.read()).pending; n++) await f.runner().reconcile();
    const complete = await f.journal.read();
    assert.equal(complete.pending, null); assert.equal(complete.expiredDrafts.length, 1);
    assert.ok(complete.expiredDrafts[0].throughBlockHeight > p.lastValidBlockHeight);
    assert.equal(complete.receipts.length, signed ? 1 : 0, "an unsigned draft is not fabricated as a transaction receipt");
    if (signed) assert.equal(complete.receipts[0].status, "expired-unexecuted", "expiry proof is NEVER a finalized execution receipt");
    assert.equal(complete.ownerSolDebitLamports, "0"); assert.equal(complete.keeperSolDebitLamports, "0");
  } finally { Date.now = clock; await f.db.close(); }
  }
});

test("canonical expiry scan recovers an externally landed signature without inventing absence", async () => {
  const f = await fixture(), clock = Date.now; Date.now = f.vm.now;
  try {
    const p = (await f.runner().prepare("keeper")).pending!;
    const applied = await localCycleReceipt(f.vm, p.txBase64, cycleTestKeeper);
    assert.equal((await f.journal.read()).pending!.signature, null, "wallet lost its response before the app could latch it");
    f.vm.svm.warpToSlot(BigInt(p.minSlot + 2));
    f.vm.connection.getBlockHeight = async () => p.lastValidBlockHeight + 2;
    f.vm.connection.getSlot = async () => p.minSlot + 200;
    f.vm.connection.isBlockhashValid = async () => ({ context: { slot: p.minSlot + 200 }, value: false });
    f.vm.connection.getFirstAvailableBlock = async () => 0;
    f.vm.connection.getBlocks = async start => [start, start + 1];
    const hash = (slot: number) => slot === p.minSlot ? p.blockhash : bs58.encode(Buffer.from(sha256(Buffer.from(`SYNTHETIC-RECOVERY-FIXTURE-${slot}`)), "hex"));
    // Real local program metadata in synthetic block headers; not reconstructed mainnet banks.
    f.vm.connection.getBlock = (async (slot: number) => ({ blockhash: hash(slot), previousBlockhash: hash(slot - 1), parentSlot: slot - 1, blockHeight: slot, blockTime: null, transactions: slot === p.minSlot + 1 ? [{ transaction: applied.transaction, meta: applied.meta, version: applied.version }] : [] })) as unknown as typeof f.vm.connection.getBlock;
    const recovered = await f.runner().reconcile();
    assert.equal(recovered.pending, null); assert.equal(recovered.expiredDrafts.length, 0);
    assert.equal(recovered.receipts[0].signature, applied.transaction.signatures[0]);
    assert.equal(recovered.receipts[0].status, "finalized");
    assert.ok(BigInt(recovered.keeperSolDebitLamports) > 0n);
    await f.runner().reconcile(); assert.equal((await f.journal.read()).receipts.length, 1);
  } finally { Date.now = clock; await f.db.close(); }
});

test("owner cancels and recovers a funded deposit after deposits and keeper automation stop", async () => {
  const f = await fixture(), clock = Date.now; Date.now = f.vm.now;
  try {
    f.vm.seed(f.policy.owner, MAINNET_USDC, 100_000_123n);
    async function execute(actor: "owner" | "keeper", expected: string, request: "next" | "recover" = "next") {
      const step = await f.runner().prepare(actor, request);
      assert.equal(step.action, expected, step.reason); assert(step.pending);
      const tx = VersionedTransaction.deserialize(Buffer.from(step.pending.txBase64, "base64")); tx.sign([actor === "owner" ? cycleTestOwner : cycleTestKeeper]);
      await f.runner().submit(actor, Buffer.from(tx.serialize()).toString("base64"));
      return f.runner().reconcile();
    }
    await execute("keeper", "setup-keeper"); await execute("keeper", "setup-keeper");
    await execute("owner", "create"); await execute("owner", "contribute");
    f.record.depositsEnabled = false; f.record.keeper.automationEnabled = false;
    await assert.rejects(f.runner().prepare("keeper"), /DEPOSIT|AUTOMATION/);
    await execute("owner", "cancel", "recover");
    for (let n = 0; n < 12; n++) {
      const step = await f.runner().prepare("owner");
      if (step.action === "complete") break;
      assert(step.pending, step.reason); assert.ok(["claim", "cleanup"].includes(step.action));
      const tx = VersionedTransaction.deserialize(Buffer.from(step.pending.txBase64, "base64")); tx.sign([cycleTestOwner]);
      await f.runner().submit("owner", Buffer.from(tx.serialize()).toString("base64")); await f.runner().reconcile();
    }
    const state = await f.journal.read();
    assert.equal(state.phase, "complete"); assert.equal(state.nativeClaimsClear, true);
    assert.equal(state.recoveredUsdcRaw, "100000000"); assert.equal(state.mintedSharesRaw, "0");
    assert.equal(await f.vm.balance(f.policy.owner, MAINNET_USDC), 100_000_123n, "unrelated starting cash is untouched");
  } finally { Date.now = clock; await f.db.close(); }
});
