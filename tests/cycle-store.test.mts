import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { CycleJournal, bindCycleSubmission, initialCycleState, type CyclePending } from "../src/lib/index-vaults/cycle-store.ts";
import { cyclePolicyHash } from "../src/lib/index-vaults/cycle-policy.ts";
import { sha256 } from "../src/lib/index-vaults/amounts.ts";
import { cycleDb } from "./support/cycle-db.mts";
import { cycleTestPolicy, cycleTestOwner } from "./support/cycle-policy.mts";

test("durable cycles fence concurrent writers, survive journal reconstruction, and isolate native owner-PDA generations", async () => {
  const db = await cycleDb();
  try {
    const p = cycleTestPolicy(), a = new CycleJournal(p, db.rpc), b = new CycleJournal(p, db.rpc);
    let unlock!: () => void, entered!: () => void;
    const ready = new Promise<void>(r => { entered = r; }), held = new Promise<void>(r => { unlock = r; });
    const first = a.update(async state => { entered(); await held; state.phase = "investing"; });
    await ready;
    await assert.rejects(b.update(() => {}), /LOCK_HELD_RECOVERY_REQUIRED/);
    unlock(); await first;
    assert.equal((await b.read()).phase, "investing");
    const renewed = new CycleJournal({ ...p, expiresAt: p.expiresAt + 3600000, approvalReference: "explicit deadline renewal" }, db.rpc);
    assert.equal((await renewed.read()).phase, "investing", "same operation and money limits survive explicitly renewed authority");
    const changedBudget = new CycleJournal({ ...p, limits: { ...p.limits, maxOwnerSolDebitLamports: "20000000" } }, db.rpc);
    await assert.rejects(changedBudget.read(), /IDENTITY_OR_POLICY_CHANGED/);
    const alias = new CycleJournal({ ...p, indexId: "another-index-same-vault", operationId: randomUUID() }, db.rpc);
    await assert.rejects(alias.update(() => {}), /one_native_generation/);
    const otherWallet = new CycleJournal({ ...p, owner: p.keeper, operationId: randomUUID() }, db.rpc);
    await otherWallet.update(() => {});
    await assert.rejects(a.update(state => { state.owner = p.keeper; }), /IDENTITY_OR_POLICY_CHANGED/);
    assert.equal((await b.read()).owner, p.owner);
    await assert.rejects(db.asRole("anon", () => db.rpc("read_insiderindex_cycle", { p_operation_id: p.operationId })), /permission denied/);
    await assert.rejects(db.asRole("authenticated", () => db.rpc("read_insiderindex_cycle", { p_operation_id: p.operationId })), /permission denied/);
  } finally { await db.close(); }
});
test("signature is durable before relay; ambiguous broadcasts cannot be forgotten or replaced", async () => {
  const db = await cycleDb();
  try {
    const p = cycleTestPolicy(), journal = new CycleJournal(p, db.rpc);
    // Local storage test only: this transfer is NOT a cycle-authorized message and is never sent.
    const message = new TransactionMessage({ payerKey: cycleTestOwner.publicKey, recentBlockhash: PublicKey.default.toBase58(), instructions: [SystemProgram.transfer({ fromPubkey: cycleTestOwner.publicKey, toPubkey: cycleTestOwner.publicKey, lamports: 1 })] }).compileToV0Message();
    const tx = new VersionedTransaction(message), unsigned = Buffer.from(tx.serialize()).toString("base64");
    const pending: CyclePending = { stepId: randomUUID(), action: "create", policyHash: cyclePolicyHash(p), txBase64: unsigned, messageHash: sha256(message.serialize()), payer: p.owner, blockhash: message.recentBlockhash, expiresAt: Date.now() + 60000, lastValidBlockHeight: 100, minSlot: 0, mints: [], expectedOwnerShareDelta: "0", expectedFeeShareDelta: "0", beforeStateHash: "0".repeat(64), simulatedPayerDebitLamports: "1", signature: null, signedTransaction: null };
    await journal.update(s => { s.pending = pending; });
    tx.sign([cycleTestOwner]); const signed = Buffer.from(tx.serialize()).toString("base64");
    const signature = await journal.update(s => bindCycleSubmission(s, signed));
    assert.equal((await new CycleJournal(p, db.rpc).read()).pending!.signature, signature);
    await assert.rejects(journal.update(s => { s.pending = null; }), /INFLIGHT_SIGNATURE_CANNOT_BE_FORGOTTEN/);
    assert.equal((await journal.read()).pending!.signedTransaction, signed);
    await journal.update(s => {
      s.receipts.push({ signature, messageHash: pending.messageHash, action: "create", slot: 1, status: "failed", payer: p.owner, payerDebitLamports: "1" });
      s.ownerSolDebitLamports = "1"; s.pending = null;
    });
    await assert.rejects(journal.update(s => { s.ownerSolDebitLamports = "0"; }), /FEE_TOTAL_DIVERGENCE/);
    await assert.rejects(journal.update(s => { s.receipts = []; s.ownerSolDebitLamports = "0"; }), /RECEIPT_HISTORY_IMMUTABLE/);
    await journal.update(s => { s.mintedSharesRaw = "1"; });
    await assert.rejects(journal.update(s => { s.phase = "complete"; }), /NATIVE_EXIT_OUTSTANDING/);
  } finally { await db.close(); }
});
test("a crashed lease has no timer takeover and an obsolete writer cannot overwrite recovered state", async () => {
  const db = await cycleDb();
  try {
    const p = cycleTestPolicy(), old = randomUUID(), next = randomUUID(), initial = initialCycleState(p);
    await db.rpc("lock_insiderindex_cycle", { p_operation_id: p.operationId, p_token: old, p_initial: initial });
    await assert.rejects(db.rpc("lock_insiderindex_cycle", { p_operation_id: p.operationId, p_token: next, p_initial: initial }), /LOCK_HELD/);
    await assert.rejects(db.rpc("recover_insiderindex_cycle_lock", { p_operation_id: p.operationId, p_expected_token: next }), /WRITER_FENCE/);
    await db.rpc("recover_insiderindex_cycle_lock", { p_operation_id: p.operationId, p_expected_token: old });
    await db.rpc("lock_insiderindex_cycle", { p_operation_id: p.operationId, p_token: next, p_initial: initial });
    await assert.rejects(db.rpc("write_insiderindex_cycle", { p_operation_id: p.operationId, p_token: old, p_revision: 0, p_state: initial }), /WRITER_FENCE/);
    await db.rpc("release_insiderindex_cycle", { p_operation_id: p.operationId, p_token: next });
    const unavailable = new CycleJournal(p, async () => { throw new Error("storage unavailable"); });
    await assert.rejects(unavailable.update(() => { throw new Error("must never reach unjournaled work"); }), /storage unavailable/);
  } finally { await db.close(); }
});
