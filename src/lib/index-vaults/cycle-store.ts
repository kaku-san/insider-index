import { randomUUID } from "node:crypto";
import bs58 from "bs58";
import { VersionedTransaction } from "@solana/web3.js";
import { createServiceSupabase } from "../supabase.ts";
import { address, rawAmount, sha256 } from "./amounts.ts";
import { assertSignedBy } from "./kaku-san-create.ts";
import { creditSaleAmount, type CycleCredit } from "./cycle-accounting.ts";
import { cyclePolicyHash, type CyclePolicy } from "./cycle-policy.ts";
import type { CycleMintBinding } from "./cycle-receipts.ts";
import type { CycleWire } from "./cycle-wire.ts";

export type CycleAction = "setup-keeper" | "create" | "contribute" | "lock" | "prices" | "fill" | "mint" | "cleanup" | "withdraw" | "claim" | "convert" | "cancel";
export interface CyclePending extends CycleWire {
  stepId: string; action: CycleAction; policyHash: string; expiresAt: number; lastValidBlockHeight: number;
  beforeStateHash: string; simulatedPayerDebitLamports: string;
  inputMint?: string; exactInputRaw?: string; minOutputRaw?: string;
  minSlot: number; mints: CycleMintBinding[];
  expectedOwnerShareDelta: string; expectedFeeShareDelta: string;
  expiryScan?: { nextSlot: number; throughBlockHeight: number; lastSlot: number; blockhash: string };
  surplusPricesQ?: Record<string, string>;
  bounty?: { account: string; restoreWsolRaw: string; fundingRaw: string };
  signature: string | null; signedTransaction: string | null;
}
export interface CycleReceiptRecord {
  signature: string; messageHash: string; action: CycleAction; slot: number;
  status: "finalized" | "failed" | "expired-unexecuted"; payer: string; payerDebitLamports: string;
}
export interface CycleState {
  schema: "insiderindex-native-cycle-v1";
  indexId: string; vault: string; shareMint: string; owner: string; keeper: string; operationId: string;
  policyHash: string; definitionHash: string;
  /** Immutable selected amount; absent only on pre-variable-amount journals. */
  approvedDepositUsdcRaw?: string;
  phase: "new" | "investing" | "holding" | "exiting" | "recovering" | "complete";
  depositGenerationSignature: string | null; exitGenerationSignature: string | null;
  contributedUsdcRaw: string; mintedSharesRaw: string; burnedSharesRaw: string; recoveredUsdcRaw: string;
  ownerSolDebitLamports: string; keeperSolDebitLamports: string; keeperSurplusUsdcRaw: string; bountyFundingRaw: string;
  nativeClaimsClear: boolean; credits: CycleCredit[]; receipts: CycleReceiptRecord[];
  expiredDrafts: { stepId: string; messageHash: string; throughSlot: number; throughBlockHeight: number }[];
  pending: CyclePending | null; recoveryRequired: string | null;
}
export function initialCycleState(policy: CyclePolicy): CycleState {
  return { schema: "insiderindex-native-cycle-v1", indexId: policy.indexId, vault: policy.vault, shareMint: policy.shareMint, owner: policy.owner, keeper: policy.keeper, operationId: policy.operationId,
    policyHash: cyclePolicyHash(policy), definitionHash: policy.definitionHash, approvedDepositUsdcRaw: policy.limits.depositUsdcRaw, phase: "new", depositGenerationSignature: null, exitGenerationSignature: null,
    contributedUsdcRaw: "0", mintedSharesRaw: "0", burnedSharesRaw: "0", recoveredUsdcRaw: "0", ownerSolDebitLamports: "0", keeperSolDebitLamports: "0", keeperSurplusUsdcRaw: "0", bountyFundingRaw: "0",
    nativeClaimsClear: true, credits: [], receipts: [], expiredDrafts: [], pending: null, recoveryRequired: null };
}
/** A selected public amount can change only before any real contribution/share progress and
 * after every issued draft is durably resolved. An unsigned wire is not disposable: it might
 * have been signed or broadcast outside the app, so reconciliation must produce expiry history
 * before a later discovery can restart this journal. */
export function cycleAmountRestartable(state: CycleState): boolean {
  return (state.phase === "new" || state.phase === "investing")
    && rawAmount(state.contributedUsdcRaw) === 0n
    && rawAmount(state.mintedSharesRaw) === 0n
    && state.pending === null
    && !state.receipts.some(receipt => receipt.status === "finalized" && (receipt.action === "contribute" || receipt.action === "mint"));
}
export function assertCycleState(state: CycleState, initial: CycleState): void {
  if (!state || state.schema !== initial.schema || ["indexId", "vault", "shareMint", "owner", "keeper", "operationId", "definitionHash", "policyHash"].some(k => state[k as keyof CycleState] !== initial[k as keyof CycleState])) throw new Error("CYCLE_JOURNAL_IDENTITY_OR_POLICY_CHANGED");
  if (state.approvedDepositUsdcRaw !== undefined && state.approvedDepositUsdcRaw !== initial.approvedDepositUsdcRaw) throw new Error("CYCLE_JOURNAL_IDENTITY_OR_POLICY_CHANGED");
  for (const key of ["vault", "shareMint", "owner", "keeper"] as const) address(state[key]);
  for (const key of ["contributedUsdcRaw", "mintedSharesRaw", "burnedSharesRaw", "recoveredUsdcRaw", "ownerSolDebitLamports", "keeperSolDebitLamports", "keeperSurplusUsdcRaw", "bountyFundingRaw"] as const) rawAmount(state[key]);
  if (!["new", "investing", "holding", "exiting", "recovering", "complete"].includes(state.phase) || !Array.isArray(state.credits) || !Array.isArray(state.receipts) || typeof state.nativeClaimsClear !== "boolean") throw new Error("CYCLE_JOURNAL_SHAPE");
  for (const mint of new Set(state.credits.map(c => c.mint))) {
    const remaining = creditSaleAmount(state.credits, state, mint);
    if (state.phase === "complete" && remaining !== 0n) throw new Error("CYCLE_OUTSTANDING_CREDITS");
  }
  const signatures = new Set<string>();
  for (const r of state.receipts) {
    if (signatures.has(r.signature) || !/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(r.signature) || !/^[a-f0-9]{64}$/.test(r.messageHash) || !Number.isSafeInteger(r.slot) || r.slot < 0 || ![state.owner, state.keeper].includes(r.payer) || !["finalized", "failed", "expired-unexecuted"].includes(r.status)) throw new Error("CYCLE_JOURNAL_RECEIPT");
    rawAmount(r.payerDebitLamports); signatures.add(r.signature);
  }
  if (!Array.isArray(state.expiredDrafts)) throw new Error("CYCLE_JOURNAL_EXPIRY_AUDIT_MALFORMED");
  for (const d of state.expiredDrafts) if (!/^[0-9a-f-]{36}$/.test(d.stepId) || !/^[a-f0-9]{64}$/.test(d.messageHash) || !Number.isSafeInteger(d.throughSlot) || d.throughSlot < 0 || !Number.isSafeInteger(d.throughBlockHeight) || d.throughBlockHeight < 0) throw new Error("CYCLE_JOURNAL_EXPIRY_AUDIT_MALFORMED");
  for (const [payer, field] of [[state.owner, "ownerSolDebitLamports"], [state.keeper, "keeperSolDebitLamports"]] as const) {
    const debit = state.receipts.filter(r => r.payer === payer).reduce((sum, r) => sum + rawAmount(r.payerDebitLamports), 0n);
    if (rawAmount(state[field]) !== debit) throw new Error("CYCLE_JOURNAL_FEE_TOTAL_DIVERGENCE");
  }
  if (state.pending) {
    const p = state.pending, tx = VersionedTransaction.deserialize(Buffer.from(p.txBase64, "base64"));
    if (p.messageHash !== sha256(tx.message.serialize()) || p.blockhash !== tx.message.recentBlockhash || !Number.isSafeInteger(p.minSlot) || p.minSlot < 0 || p.policyHash !== state.policyHash || ![state.owner, state.keeper].includes(p.payer) || tx.message.staticAccountKeys[0].toBase58() !== p.payer || tx.message.header.numRequiredSignatures !== 1 || tx.signatures.some(s => s.some(b => b !== 0)) || !Number.isSafeInteger(p.expiresAt) || !Number.isSafeInteger(p.lastValidBlockHeight) || p.lastValidBlockHeight < 0) throw new Error("CYCLE_JOURNAL_PENDING_MESSAGE");
    rawAmount(p.simulatedPayerDebitLamports);
    if (!Array.isArray(p.mints) || new Set(p.mints.map(m => m.mint)).size !== p.mints.length || p.mints.some(m => { address(m.mint); address(m.tokenProgram); return !Number.isInteger(m.decimals) || m.decimals < 0 || m.decimals > 255; })) throw new Error("CYCLE_JOURNAL_MINT_BINDINGS");
    for (const d of [p.expectedOwnerShareDelta, p.expectedFeeShareDelta]) if (!/^(0|-?[1-9]\d{0,19})$/.test(d)) throw new Error("CYCLE_JOURNAL_EXPECTED_SHARE_EFFECT");
    if (p.expiryScan) {
      const s = p.expiryScan; address(s.blockhash);
      if (![s.nextSlot, s.lastSlot, s.throughBlockHeight].every(n => Number.isSafeInteger(n) && n >= 0) || s.nextSlot <= s.lastSlot || s.lastSlot < p.minSlot) throw new Error("CYCLE_JOURNAL_EXPIRY_CURSOR");
    }
    if ((p.signature === null) !== (p.signedTransaction === null)) throw new Error("CYCLE_JOURNAL_SIGNATURE_LATCH");
    if (p.signedTransaction) {
      const signed = assertSignedBy(p.signedTransaction, p.payer);
      if (sha256(signed.message.serialize()) !== p.messageHash || bs58.encode(signed.signatures[0]) !== p.signature) throw new Error("CYCLE_JOURNAL_SIGNATURE_LATCH");
    }
  }
  if (state.phase === "complete" && (rawAmount(state.burnedSharesRaw) < rawAmount(state.mintedSharesRaw) || (rawAmount(state.contributedUsdcRaw) > 0n && !state.exitGenerationSignature && !state.receipts.some(r => r.action === "cancel" && r.status === "finalized")))) throw new Error("CYCLE_NATIVE_EXIT_OUTSTANDING");
  if (state.phase === "complete" && (state.pending || !state.nativeClaimsClear || state.recoveryRequired)) throw new Error("CYCLE_OUTSTANDING_OBLIGATIONS");
}
/** Mutate only under the durable lease. The caller MUST await the journal commit before sending. */
export function bindCycleSubmission(state: CycleState, signedTransaction: string, now = Date.now()): string {
  const p = state.pending; if (!p || p.expiresAt <= now) throw new Error("CYCLE_DRAFT_MISSING_OR_EXPIRED");
  const signed = assertSignedBy(signedTransaction, p.payer);
  if (sha256(signed.message.serialize()) !== p.messageHash || signed.message.header.numRequiredSignatures !== 1) throw new Error("CYCLE_SIGNED_MESSAGE_CHANGED");
  const signature = bs58.encode(signed.signatures[0]);
  if (p.signature && p.signature !== signature) throw new Error("CYCLE_INFLIGHT_SIGNATURE_CONFLICT");
  p.signature = signature; p.signedTransaction = signedTransaction;
  return signature;
}
export type CycleRpc = (fn: string, args: Record<string, unknown>) => Promise<unknown>;
export function cycleRpcFromEnv(): CycleRpc {
  return async (fn, args) => {
    const db = createServiceSupabase(); if (!db) throw new Error("CYCLE_DURABLE_SERVICE_ROLE_REQUIRED");
    const { data, error } = await db.rpc(fn, args);
    if (error) throw new Error(`CYCLE_JOURNAL_UNAVAILABLE:${error.code ?? "storage"}`);
    return data;
  };
}
export async function listIncompleteCycleOperations(vault: string, rpc: CycleRpc = cycleRpcFromEnv()): Promise<{ operationId: string; owner: string }[]> {
  address(vault);
  const value = await rpc("list_insiderindex_cycles_for_vault", { p_vault: vault });
  if (!Array.isArray(value)) throw new Error("CYCLE_JOURNAL_UNREADABLE");
  return value.map(row => {
    if (!row || typeof row !== "object" || typeof (row as { operationId?: unknown }).operationId !== "string" || typeof (row as { owner?: unknown }).owner !== "string") throw new Error("CYCLE_JOURNAL_UNREADABLE");
    return { operationId: (row as { operationId: string }).operationId, owner: (row as { owner: string }).owner };
  });
}
/** Shared Postgres row + non-expiring lease. Never /tmp, a relative .data path, or process memory. */
export class CycleJournal {
  private initial: CycleState;
  private rpc: CycleRpc;
  constructor(policy: CyclePolicy, rpc: CycleRpc = cycleRpcFromEnv()) { this.initial = initialCycleState(policy); this.rpc = rpc; }
  async read(): Promise<CycleState> {
    const value = await this.rpc("read_insiderindex_cycle", { p_operation_id: this.initial.operationId });
    if (value === null) return structuredClone(this.initial);
    if (!value || typeof value !== "object" || !("state" in value)) throw new Error("CYCLE_JOURNAL_UNREADABLE");
    const state = value.state as CycleState; assertCycleState(state, this.initial); return state;
  }
  async update<R>(fn: (state: CycleState) => R | Promise<R>): Promise<R> {
    const token = randomUUID(), identity = { p_operation_id: this.initial.operationId, p_token: token };
    const raw = await this.rpc("lock_insiderindex_cycle", { ...identity, p_initial: this.initial });
    let failed = false;
    try {
      if (!raw || typeof raw !== "object" || !("state" in raw) || !("revision" in raw) || !Number.isSafeInteger(raw.revision)) throw new Error("CYCLE_JOURNAL_UNREADABLE");
      const state = raw.state as CycleState; assertCycleState(state, this.initial);
      const result = await fn(state); assertCycleState(state, this.initial);
      await this.rpc("write_insiderindex_cycle", { ...identity, p_revision: raw.revision, p_state: state });
      return result;
    } catch (error) { failed = true; throw error; }
    finally {
      try { await this.rpc("release_insiderindex_cycle", identity); }
      catch { if (!failed) throw new Error("CYCLE_JOURNAL_RELEASE_FAILED_RECOVERY_REQUIRED"); }
    }
  }
  /** Replace the selected public amount and an obsolete definition/policy binding under the
   * existing durable lease. SQL independently permits this only for an empty restartable row. */
  async restartEmptyAmount(replacement: CyclePolicy): Promise<boolean> {
    const next = initialCycleState(replacement), current = this.initial;
    for (const key of ["indexId", "vault", "shareMint", "owner", "keeper", "operationId"] as const) {
      if (next[key] !== current[key]) throw new Error("CYCLE_JOURNAL_IDENTITY_OR_POLICY_CHANGED");
    }
    const token = randomUUID(), identity = { p_operation_id: current.operationId, p_token: token };
    const raw = await this.rpc("lock_insiderindex_cycle", { ...identity, p_initial: current });
    let failed = false;
    try {
      if (!raw || typeof raw !== "object" || !("state" in raw) || !("revision" in raw) || !Number.isSafeInteger(raw.revision)) throw new Error("CYCLE_JOURNAL_UNREADABLE");
      const state = raw.state as CycleState;
      // The old definition/policy is exactly what this narrow recovery replaces. Validate the
      // stored state against itself before checking only the immutable operation identity.
      assertCycleState(state, state);
      if (["indexId", "vault", "shareMint", "owner", "keeper", "operationId"].some(key => state[key as keyof CycleState] !== next[key as keyof CycleState])) throw new Error("CYCLE_JOURNAL_IDENTITY_OR_POLICY_CHANGED");
      if (!cycleAmountRestartable(state)) return false;
      state.definitionHash = next.definitionHash;
      state.policyHash = next.policyHash;
      state.approvedDepositUsdcRaw = next.approvedDepositUsdcRaw;
      assertCycleState(state, next);
      await this.rpc("write_insiderindex_cycle", { ...identity, p_revision: raw.revision, p_state: state });
      this.initial = next;
      return true;
    } catch (error) { failed = true; throw error; }
    finally {
      try { await this.rpc("release_insiderindex_cycle", identity); }
      catch { if (!failed) throw new Error("CYCLE_JOURNAL_RELEASE_FAILED_RECOVERY_REQUIRED"); }
    }
  }
}
