import bs58 from "bs58";
import { VersionedTransaction, type VersionedTransactionResponse } from "@solana/web3.js";
import { sha256, rawAmount } from "./amounts.ts";
import { assertSignedBy } from "./kaku-san-create.ts";
import { assertCycleExecutionAuthorized, type CyclePolicy } from "./cycle-policy.ts";
import { cycleActionPurpose } from "./cycle-policy-parse.ts";
import { CycleJournal, bindCycleSubmission, type CycleState } from "./cycle-store.ts";
import { prepareCycleStep, type CyclePreparation } from "./cycle-prepare.ts";
import { finalizeCycleAttempt } from "./cycle-finalize.ts";
import { observeCycle } from "./cycle-observer.ts";
import { MAINNET_USDC } from "./native-defaults.ts";
import { creditSaleAmount } from "./cycle-accounting.ts";
import type { NativeVaultBuilders } from "./symmetry-adapter.ts";
import type { PersistedVaultDefinition } from "./vault-definition-store.ts";
import type { PoolMetadata } from "./cycle-routes.ts";

/** No signing/key-file loading here. The app receives owner signatures; an external operator
 * process signs keeper messages. Supabase is the shared authority for all attempts/resumes. */
type CycleRunnerInput = { native: NativeVaultBuilders; policy: CyclePolicy; journal: CycleJournal;
  loadDefinition: (indexId: string) => Promise<PersistedVaultDefinition | null>; metadata?: PoolMetadata;
  /** Additional surface gate; never replaces policy/native checks. Private operator use has none. */
  executionGate?: (purpose: "deposit" | "recovery") => void };
export class CycleRunner {
  readonly input: CycleRunnerInput;
  constructor(input: CycleRunnerInput) { this.input = input; }
  private async definition() {
    const record = await this.input.loadDefinition(this.input.policy.indexId);
    if (!record || record.indexId !== this.input.policy.indexId) throw new Error("CYCLE_DEFINITION_MISSING_OR_SUBSTITUTED");
    return record;
  }
  async read() { return this.input.journal.read(); }
  /** A dry-run does not acquire a writer lease, write a draft, load a key or send a transaction. */
  async preview(actor: "owner" | "keeper", request: "next" | "withdraw" | "recover" = "next") {
    const state = await this.read();
    return prepareCycleStep({ ...this.input, record: await this.definition(), state, actor, request });
  }
  async prepare(actor: "owner" | "keeper", request: "next" | "withdraw" | "recover" = "next"): Promise<CyclePreparation> {
    const current = await this.read(), recovery = request !== "next" || ["recovering", "exiting"].includes(current.phase);
    this.input.executionGate?.(current.pending ? cycleActionPurpose(current.pending.action) : recovery ? "recovery" : "deposit");
    assertCycleExecutionAuthorized(this.input.policy, await this.definition(), recovery ? "recovery" : "deposit");
    return this.input.journal.update(async state => {
      this.input.executionGate?.(state.pending ? cycleActionPurpose(state.pending.action) : request !== "next" || ["recovering", "exiting"].includes(state.phase) ? "recovery" : "deposit");
      const record = await this.definition();
      if (state.pending) {
        if (state.pending.payer !== (actor === "owner" ? this.input.policy.owner : this.input.policy.keeper)) return { action: "wait", reason: "The other actor must resolve its existing draft/signature." };
        return { action: state.pending.action, reason: "Existing durable draft/signature. Reconcile or retry only these exact bytes.", pending: state.pending };
      }
      await this.observeClosure(state, record);
      const prepared = await prepareCycleStep({ ...this.input, record, state, actor, request });
      if (prepared.pending) {
        this.input.executionGate?.(cycleActionPurpose(prepared.pending.action));
        state.pending = prepared.pending;
        if (request === "recover" && prepared.action === "cancel") state.phase = "recovering";
      } else if (prepared.action === "complete") {
        if (!state.nativeClaimsClear || rawAmount(state.burnedSharesRaw) < rawAmount(state.mintedSharesRaw) || [...new Set(state.credits.filter(c => c.mint !== MAINNET_USDC).map(c => c.mint))].some(m => creditSaleAmount(state.credits, state, m) !== 0n)) throw new Error("CYCLE_OUTSTANDING_OBLIGATIONS");
        if (rawAmount(state.contributedUsdcRaw) > 0n && rawAmount(state.recoveredUsdcRaw) < rawAmount(this.input.policy.limits.minExitUsdcRaw)) throw new Error("CYCLE_REALIZED_USDC_BELOW_APPROVED_MINIMUM");
        if (state.recoveryRequired) throw new Error("CYCLE_RECOVERY_AUDIT_REQUIRED_BEFORE_COMPLETION");
        state.phase = "complete";
      }
      return prepared;
    });
  }
  /** Latch and COMMIT before relay. A timeout/error after this point must never produce a
   * replacement transaction; caller may retry the same bytes or reconcile finality. */
  async submit(actor: "owner" | "keeper", signedTransaction: string) {
    const payer = actor === "owner" ? this.input.policy.owner : this.input.policy.keeper;
    const signed = assertSignedBy(signedTransaction, payer), signature = bs58.encode(signed.signatures[0]);
    const current = await this.read();
    if (!current.pending && !current.receipts.some(r => r.signature === signature)) throw new Error("CYCLE_SIGNATURE_WRONG_ROLE_OR_DRAFT");
    await this.input.journal.update(state => {
      const existing = state.receipts.find(r => r.signature === signature);
      if (existing) {
        if (existing.messageHash !== sha256(signed.message.serialize()) || existing.payer !== payer) throw new Error("CYCLE_TERMINAL_SIGNATURE_CONFLICT");
        return;
      }
      if (!state.pending || state.pending.payer !== payer) throw new Error("CYCLE_SIGNATURE_WRONG_ROLE_OR_DRAFT");
      if (state.pending.signature === signature) return; // known obligation, including an expired offer
      bindCycleSubmission(state, signedTransaction);
    });
    return this.relay(actor, signature);
  }
  private async relay(actor: "owner" | "keeper", signature: string) {
    return this.input.journal.update(async state => {
      const prior = state.receipts.find(r => r.signature === signature);
      if (prior) return { signature, status: prior.status };
      const p = state.pending, { native, policy } = this.input;
      if (!p?.signedTransaction || p.signature !== signature || p.payer !== (actor === "owner" ? policy.owner : policy.keeper)) throw new Error("CYCLE_SIGNATURE_NOT_DURABLE");
      const status = (await native.connection.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0];
      if (status) return { signature, status: "pending-finalized-reconciliation" };
      const record = await this.definition();
      const purpose = cycleActionPurpose(p.action);
      this.input.executionGate?.(purpose);
      assertCycleExecutionAuthorized(policy, record, purpose);
      if (p.expiresAt <= Date.now() || await native.connection.getBlockHeight("confirmed") > p.lastValidBlockHeight) throw new Error("CYCLE_SIGNED_OFFER_EXPIRED_RECONCILE");
      const request = p.action === "withdraw" ? "withdraw" : p.action === "cancel" ? "recover" : "next";
      const audited = await prepareCycleStep({ ...this.input, record, state, actor, request, revalidate: p });
      if (audited.pending?.messageHash !== p.messageHash) throw new Error("CYCLE_REVALIDATION_CHANGED_MESSAGE");
      // This send can be ambiguous. The exact signature/bytes were committed in the PREVIOUS
      // journal transaction. Never discard them because an RPC throws or the caller disconnects.
      const returned = await native.connection.sendRawTransaction(Buffer.from(p.signedTransaction, "base64"), { skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 0, minContextSlot: p.minSlot });
      if (returned !== signature) throw new Error("CYCLE_RELAY_SIGNATURE_MISMATCH_RECONCILE");
      return { signature, status: "pending-finalized-reconciliation" };
    });
  }
  async reconcile(): Promise<CycleState> {
    const current = await this.read();
    if (!current.pending && !current.receipts.length && !current.expiredDrafts.length) return current;
    return this.input.journal.update(async state => {
      const p = state.pending, { native, policy } = this.input;
      await native.assertNetwork();
      if (p?.signature) {
        const response = await native.connection.getTransaction(p.signature, { commitment: "finalized", maxSupportedTransactionVersion: 0 });
        if (response) finalizeCycleAttempt(state, policy, response);
      }
      if (state.pending && await native.connection.getBlockHeight("finalized") > state.pending.lastValidBlockHeight) {
        const validity = await native.connection.isBlockhashValid(state.pending.blockhash, { commitment: "finalized" });
        if (validity.context.slot < state.pending.minSlot) throw new Error("CYCLE_EXPIRY_VALIDITY_OBSERVER_STALE");
        if (!validity.value) await this.scanExpiredAttempt(state);
      }
      if (!state.pending) await this.observeClosure(state, await this.definition());
      return state;
    });
  }
  private async observeClosure(state: CycleState, record: PersistedVaultDefinition) {
    const chain = await observeCycle(this.input.native, record, this.input.policy, "recovery", "finalized");
    const lastLandedSlot = Math.max(0, ...state.receipts.filter(r => r.status === "finalized" || r.status === "failed").map(r => r.slot));
    if (chain.slot < lastLandedSlot) throw new Error("CYCLE_OBSERVATION_BEHIND_FINALIZED_RECEIPT");
    state.nativeClaimsClear = chain.intent === null;
    if (state.nativeClaimsClear && state.phase === "investing" && state.receipts.some(r => r.action === "mint" && r.status === "finalized")) state.phase = "holding";
  }
  /** A null getTransaction/status is not proof of non-execution. Scan consecutive FINALIZED
   * blocks from the finalized blockhash root through expiry. Two blocks per call bounds work;
   * missing/pruned history or a block-height gap retains the obligation for operator recovery.
   * Full messages also recover a wallet's lost signature for an already-issued unsigned draft. */
  private async scanExpiredAttempt(state: CycleState): Promise<void> {
    const p = state.pending!, connection = this.input.native.connection;
    if (await connection.getFirstAvailableBlock() > p.minSlot) throw new Error("CYCLE_EXPIRY_HISTORY_PRUNED_RECOVERY_REQUIRED");
    const start = p.expiryScan?.nextSlot ?? p.minSlot;
    const end = Math.min(start + 63, await connection.getSlot("finalized"));
    if (end < start) throw new Error("CYCLE_EXPIRY_FINALITY_BEHIND_SCAN");
    const slots = (await connection.getBlocks(start, end, "finalized")).slice(0, 2);
    if (!p.expiryScan && slots[0] !== p.minSlot) throw new Error("CYCLE_EXPIRY_ROOT_UNAVAILABLE_RECOVERY_REQUIRED");
    if (!slots.length) { p.expiryScan = { ...p.expiryScan!, nextSlot: end + 1 }; return; }
    for (const slot of slots) {
      if (!Number.isSafeInteger(slot) || slot < start) throw new Error("CYCLE_EXPIRY_SLOT_ORDER");
      const block = await connection.getBlock(slot, { commitment: "finalized", transactionDetails: "full", maxSupportedTransactionVersion: 0, rewards: false });
      // web3's runtime validates/preserves blockHeight, but VersionedBlockResponse omits it.
      const height = block && "blockHeight" in block ? block.blockHeight : null;
      if (!block || typeof height !== "number" || !Number.isSafeInteger(height) || (p.expiryScan && (height !== p.expiryScan.throughBlockHeight + 1 || block.parentSlot !== p.expiryScan.lastSlot || block.previousBlockhash !== p.expiryScan.blockhash)) || (!p.expiryScan && block.blockhash !== p.blockhash)) throw new Error("CYCLE_EXPIRY_HISTORY_GAP_RECOVERY_REQUIRED");
      for (const entry of block.transactions) {
        if (sha256(entry.transaction.message.serialize()) !== p.messageHash) continue;
        const signature = entry.transaction.signatures[0];
        if (p.signature && p.signature !== signature) throw new Error("CYCLE_ALTERNATE_SIGNATURE_REQUIRES_RECONCILIATION");
        const signed = new VersionedTransaction(entry.transaction.message, entry.transaction.signatures.map(s => bs58.decode(s)));
        const wire = Buffer.from(signed.serialize()).toString("base64"); assertSignedBy(wire, p.payer);
        p.signature = signature; p.signedTransaction = wire;
        const response: VersionedTransactionResponse = { ...entry, slot, blockTime: block.blockTime };
        finalizeCycleAttempt(state, this.input.policy, response);
        return;
      }
      p.expiryScan = { nextSlot: slot + 1, throughBlockHeight: height, lastSlot: slot, blockhash: block.blockhash };
      if (height > p.lastValidBlockHeight) {
        if (p.signature) state.receipts.push({ signature: p.signature, messageHash: p.messageHash, action: p.action, slot, status: "expired-unexecuted", payer: p.payer, payerDebitLamports: "0" });
        state.expiredDrafts.push({ stepId: p.stepId, messageHash: p.messageHash, throughSlot: slot, throughBlockHeight: height });
        state.pending = null;
        return;
      }
    }
  }
}
