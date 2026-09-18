import { VersionedTransaction, type Keypair } from "@solana/web3.js";
import { assertCycleExecutionAuthorized } from "./cycle-policy.ts";
import type { CycleRunner } from "./cycle-runner.ts";
const OWNER_WAIT = /CYCLE_(OWNER_SIGNATURE_REQUIRED|OWNER_RECOVERY_AUTHORITY_REQUIRED|WITHDRAW_REQUIRES_HELD_SHARES)/;

/** External operator process only. No key loading, schedule override, server custody or
 * force-rebalance. Dry run is read/simulate only: no lease, journal mutation or relay. */
export async function cycleKeeperTick(runner: CycleRunner, options: { execute?: boolean; signer?: Keypair } = {}) {
  const execute = options.execute === true, { policy } = runner.input;
  if (!execute) {
    try { const p = await runner.preview("keeper"); return { mode: "dry-run", action: p.action, reason: p.reason, writes: false, sends: false }; }
    catch (error) {
      if (error instanceof Error && OWNER_WAIT.test(error.message)) return { mode: "dry-run", action: "wait-owner", writes: false, sends: false };
      throw error;
    }
  }
  if (!options.signer || options.signer.publicKey.toBase58() !== policy.keeper || policy.keeper === policy.owner) throw new Error("CYCLE_KEEPER_EXTERNAL_KEY_REQUIRED");
  const record = await runner.input.loadDefinition(policy.indexId);
  if (!record) throw new Error("CYCLE_DEFINITION_MISSING_OR_SUBSTITUTED");
  // Finalized accounting remains possible after shutdown; it never relays a transaction.
  const state = await runner.reconcile();
  if (state.phase === "complete" || state.phase === "holding" || state.phase === "exiting" || state.phase === "recovering") return { mode: "execute", action: "idle", phase: state.phase };
  // New execution/retries still require current dedicated automation authority and budgets.
  assertCycleExecutionAuthorized(policy, record);
  if (state.pending?.payer === policy.owner) return { mode: "execute", action: "wait-owner", pending: state.pending.action };
  let pending = state.pending;
  if (!pending) {
    try {
      const p = await runner.prepare("keeper");
      if (!p.pending) return { mode: "execute", action: p.action, reason: p.reason };
      pending = p.pending;
    } catch (error) {
      if (error instanceof Error && OWNER_WAIT.test(error.message)) return { mode: "execute", action: "wait-owner" };
      throw error;
    }
  }
  if (pending.payer !== policy.keeper) throw new Error("CYCLE_KEEPER_WRONG_PAYER");
  if (pending.expiresAt <= Date.now()) return { mode: "execute", action: "reconcile-expiry", stepId: pending.stepId };
  let signed = pending.signedTransaction;
  if (!signed) {
    const tx = VersionedTransaction.deserialize(Buffer.from(pending.txBase64, "base64"));
    if (tx.message.staticAccountKeys[0].toBase58() !== policy.keeper || tx.message.header.numRequiredSignatures !== 1 || tx.signatures.some(s => s.some(n => n !== 0))) throw new Error("CYCLE_KEEPER_DRAFT_SIGNER");
    tx.sign([options.signer]); signed = Buffer.from(tx.serialize()).toString("base64");
  }
  const result = await runner.submit("keeper", signed);
  return { mode: "execute", action: pending.action, signature: result.signature, status: result.status };
}
