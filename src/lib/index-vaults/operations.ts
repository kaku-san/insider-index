import { randomUUID } from "node:crypto";
import type { ObservedOperation, VaultIdentity } from "./adapter-contract.ts";
import { address, hashObject, rawAmount } from "./amounts.ts";
import { Journal } from "./journal.ts";

export interface TransactionAttempt {
  stepId: string; messageHash: string; signature: string; lastValidBlockHeight: number;
  state: "pending" | "finalized" | "failed" | "expired-unexecuted";
}
export interface OperationRecord {
  observed: ObservedOperation; idempotencyKey: string; requestHash: string; amountRaw: string;
  attempts: TransactionAttempt[]; receiptKeys: string[];
}
export interface OperationState { operations: OperationRecord[] }
export class OperationStore {
  readonly journal: Journal<OperationState>;
  constructor(path: string) { this.journal = new Journal(path, () => ({ operations: [] })); }
  async get(id: string): Promise<OperationRecord> {
    const row = (await this.journal.read()).operations.find(o => o.observed.operationId === id);
    if (!row) throw new Error("Unknown operation");
    return row;
  }
  async begin(input: { identity: VaultIdentity; owner: string; kind: "deposit" | "withdraw"; amountRaw: string; idempotencyKey: string }, nativeIntentExists: boolean): Promise<OperationRecord> {
    address(input.owner); rawAmount(input.amountRaw, true);
    if (!input.idempotencyKey || input.idempotencyKey.length > 128) throw new Error("Invalid idempotency key");
    const requestHash = hashObject(input);
    return this.journal.update(state => {
      const sameScope = (o: OperationRecord) => o.observed.identity.network === input.identity.network && o.observed.identity.vaultAccount === input.identity.vaultAccount && o.observed.owner === input.owner;
      const prior = state.operations.find(o => sameScope(o) && o.idempotencyKey === input.idempotencyKey);
      if (prior) { if (prior.requestHash !== requestHash) throw new Error("Idempotency conflict"); return prior; }
      if (nativeIntentExists || state.operations.some(o => sameScope(o) && !o.observed.complete)) throw new Error("Existing intent: reconcile/resume, never repeat deposit or burn");
      const row: OperationRecord = { idempotencyKey: input.idempotencyKey, requestHash, amountRaw: input.amountRaw, attempts: [], receiptKeys: [], observed: {
        operationId: randomUUID(), identity: input.identity, owner: input.owner, kind: input.kind,
        phase: "DRAFT", outstandingClaims: [], credits: [], complete: false, evidence: [],
      } };
      state.operations.push(row); return row;
    });
  }
  async bindGeneration(id: string, intent: string, creationSignature: string, firstConfirmedSlot: number): Promise<void> {
    address(intent);
    if (!Number.isSafeInteger(firstConfirmedSlot) || firstConfirmedSlot < 1 || !/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(creationSignature)) throw new Error("Invalid generation evidence");
    await this.journal.update(state => {
      const row = state.operations.find(o => o.observed.operationId === id);
      if (!row) throw new Error("Unknown operation");
      const generation = { creationSignature, firstConfirmedSlot };
      if (row.observed.intentGeneration && (hashObject(row.observed.intentGeneration) !== hashObject(generation) || row.observed.nativeIntent !== intent)) throw new Error("Intent generation conflict");
      row.observed.nativeIntent = intent; row.observed.intentGeneration = generation;
    });
  }
  async recordAttempt(id: string, attempt: TransactionAttempt): Promise<void> {
    if (attempt.state !== "pending" || !/^[a-f0-9]{64}$/.test(attempt.messageHash) || !/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(attempt.signature) || !Number.isSafeInteger(attempt.lastValidBlockHeight)) throw new Error("Invalid transaction attempt");
    await this.journal.update(state => {
      const row = state.operations.find(o => o.observed.operationId === id);
      if (!row) throw new Error("Unknown operation");
      const prior = row.attempts.find(a => a.signature === attempt.signature);
      if (prior) { if (prior.messageHash !== attempt.messageHash) throw new Error("Signature/message mismatch"); return; }
      if (row.attempts.some(a => a.stepId === attempt.stepId && (a.state === "pending" || a.state === "finalized"))) throw new Error("Resolve previous attempt before rebuilding");
      row.attempts.push(attempt);
    });
  }
  /** Trusted reconciler only; never expose a client-supplied observation endpoint. */
  async applyFinalized(id: string, observation: ObservedOperation, signature: string, slot: number): Promise<ObservedOperation> {
    return this.journal.update(state => {
      const row = state.operations.find(o => o.observed.operationId === id);
      if (!row || !row.observed.intentGeneration || !observation.intentGeneration) throw new Error("Missing intent generation");
      if (observation.operationId !== id || observation.owner !== row.observed.owner || observation.kind !== row.observed.kind ||
          hashObject(observation.identity) !== hashObject(row.observed.identity) || hashObject(observation.intentGeneration) !== hashObject(row.observed.intentGeneration) ||
          observation.nativeIntent !== row.observed.nativeIntent || slot < row.observed.intentGeneration.firstConfirmedSlot) throw new Error("Receipt does not belong to this intent generation");
      const attempt = row.attempts.find(a => a.signature === signature);
      if (!attempt) throw new Error("Receipt not bound to an expected message");
      if (observation.complete && (observation.outstandingClaims.some(c => rawAmount(c.amountRemainingRaw) > 0n) || !["COMPLETE", "COMPLETE_IN_KIND", "COMPLETE_USDC"].includes(observation.phase))) throw new Error("Outstanding obligations cannot be completed");
      const key = `${signature}:${slot}`;
      if (row.receiptKeys.includes(key)) return row.observed;
      if (row.observed.evidence.some(e => e.observedSlot > slot)) throw new Error("Out-of-order observation: replay in slot order");
      attempt.state = "finalized"; row.receiptKeys.push(key); row.observed = observation; return row.observed;
    });
  }
}

/** Timeout is not expiry. Even after block height expires, require finalized absence + state reconciliation. */
export function retryDecision(attempt: TransactionAttempt, height: number, signatureStatus: "finalized" | "failed" | "unknown", nativeStateReconciled: boolean): "reconcile" | "rebroadcast-same" | "rebuild" {
  if (signatureStatus === "finalized" || !nativeStateReconciled) return "reconcile";
  if (signatureStatus === "failed") return "rebuild";
  return height <= attempt.lastValidBlockHeight ? "rebroadcast-same" : "reconcile";
}
