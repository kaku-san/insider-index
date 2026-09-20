import bs58 from "bs58";
import { PublicKey, VersionedTransaction, type Connection } from "@solana/web3.js";
import { validateCycleAccessBinding, type CycleAccessChallenge, type CycleAccessProof } from "../index-vaults/cycle-access-parse.ts";
import { cycleActionPurpose, cycleActivationBlockers, cyclePolicyHash, type CyclePolicy } from "../index-vaults/cycle-policy-parse.ts";
import { assertPublicCycleScope, PUBLIC_MAG7, type PublicCycleBinding } from "../index-vaults/public-cycle-parse.ts";
import type { CyclePending, CycleState } from "../index-vaults/cycle-store.ts";
import type { PersistedVaultDefinition } from "../index-vaults/vault-definition-store.ts";
import { createCycleReadConnection } from "./cycle-rpc.ts";
import { assertCycleWireResolved, signValidatedCycleStep } from "./cycle-sign.ts";

export interface PublicCycleReply {
  policy: CyclePolicy; state: CycleState; record: PersistedVaultDefinition; depositEnabled: boolean;
  preparation?: { action: string; reason: string }; submission?: { signature: string; status: string };
}
export interface PublicCycleDiscovery { binding: PublicCycleBinding; challenge: CycleAccessChallenge; }
type Options = { fetch?: typeof fetch; connection?: Connection; metadata?: Parameters<typeof signValidatedCycleStep>[0]["metadata"]; isCurrent?: () => boolean };
/** Headless public flow, also exercised against the actual SQL/native test bank. No random
 * operation IDs, client budgets, user-reported receipts or wallet-side broadcasting. */
export class PublicCycleClient {
  readonly indexId = PUBLIC_MAG7.indexId;
  readonly owner: string;
  readonly origin: string;
  readonly options: Options;
  discovery: PublicCycleDiscovery | null = null;
  reply: PublicCycleReply | null = null;
  private auth: CycleAccessProof | null = null;
  private retained: { pending: CyclePending; wire: string; signature: string } | null = null;
  private busy = false;
  constructor(owner: string, origin: string, options: Options = {}) {
    const key = new PublicKey(owner);
    if (key.toBase58() !== owner || !PublicKey.isOnCurve(key.toBytes()) || new URL(origin).origin !== origin) throw new Error("CYCLE_CLIENT_SCOPE");
    this.owner = owner; this.origin = origin; this.options = options;
  }
  get hasRetainedSignature() { return this.retained !== null; }
  get retainedStepId() { return this.retained?.pending.stepId ?? null; }
  private current() { if (this.options.isCurrent?.() === false) throw new Error("CYCLE_CLIENT_WALLET_CHANGED"); }
  private async work<T>(task: () => Promise<T>): Promise<T> {
    this.current(); if (this.busy) throw new Error("CYCLE_CLIENT_BUSY"); this.busy = true;
    try { return await task(); } finally { this.busy = false; }
  }
  private async post(body: Record<string, unknown>) {
    this.current();
    const response = await (this.options.fetch ?? fetch)(`/api/indexes/${this.indexId}/cycle`, { method: "POST", headers: { "Content-Type": "application/json" }, cache: "no-store", body: JSON.stringify(body) });
    const result = await response.json(); this.current();
    if (!response.ok || result.error) {
      const error = Object.assign(new Error(result.message ?? result.error ?? "CYCLE_PUBLIC_REQUEST_FAILED"), {
        code: typeof result.code === "string" ? result.code : undefined,
      });
      throw error;
    }
    return result;
  }
  async discover(amountRaw?: string): Promise<PublicCycleDiscovery> {
    return this.work(async () => {
      const result = await this.post({ action: "discover", wallet: this.owner, ...(amountRaw === undefined ? {} : { amountRaw }) }) as PublicCycleDiscovery;
      validateCycleAccessBinding(result.challenge, result.binding, this.origin, this.owner);
      if (this.discovery && (result.binding.operationId !== this.discovery.binding.operationId || result.binding.policyHash !== this.discovery.binding.policyHash)) throw new Error("CYCLE_CLIENT_POLICY_CHANGED_REVIEW_REQUIRED");
      this.discovery = result; this.auth = null; return result;
    });
  }
  private async call(action: "read" | "prepare" | "submit" | "reconcile", fields: Record<string, unknown> = {}): Promise<PublicCycleReply> {
    if (!this.auth || !this.discovery) throw new Error("CYCLE_ACCESS_REQUIRED");
    const binding = this.discovery.binding;
    const result = await this.post({ operationId: binding.operationId, action, auth: this.auth, ...fields }) as PublicCycleReply;
    assertPublicCycleScope(result.policy);
    if (result.policy.owner !== this.owner || result.policy.operationId !== binding.operationId || cyclePolicyHash(result.policy) !== binding.policyHash || result.state.operationId !== binding.operationId || result.state.policyHash !== binding.policyHash || result.state.owner !== this.owner) throw new Error("CYCLE_CLIENT_POLICY_CHANGED_REVIEW_REQUIRED");
    this.reply = result; return result;
  }
  async authorize(signMessage: (message: string) => Promise<string>): Promise<PublicCycleReply> {
    return this.work(async () => {
      if (!this.discovery) throw new Error("CYCLE_ACCESS_REQUIRED");
      const message = validateCycleAccessBinding(this.discovery.challenge, this.discovery.binding, this.origin, this.owner);
      const signature = await signMessage(message); this.current();
      this.auth = { token: this.discovery.challenge.token, signature };
      return this.call("read");
    });
  }
  async read() { return this.work(() => this.call("read")); }
  async reconcile() { return this.work(() => this.call("reconcile")); }
  async prepare(request: "next" | "withdraw" | "recover" = "next") { return this.work(() => this.call("prepare", { request })); }
  /** Financial validation is independent of the API's declaration of safety/receipt totals. */
  async signStep(signTransaction: (wire: string, network: "mainnet-beta") => Promise<string>): Promise<PublicCycleReply> {
    return this.work(async () => {
      const reply = this.reply, pending = reply?.state.pending;
      if (!reply || !pending || pending.signature || pending.payer !== this.owner || cycleActivationBlockers(reply.policy).length || reply.policy.expiresAt <= Date.now()) throw new Error("CYCLE_CLIENT_NO_AUTHORIZED_OWNER_STEP");
      if (cycleActionPurpose(pending.action) === "deposit" && reply.depositEnabled !== true) throw new Error("CYCLE_PUBLIC_DEPOSITS_CLOSED");
      const connection = this.options.connection ?? createCycleReadConnection(this.origin);
      if (this.retained) {
        if (this.retained.pending.stepId === pending.stepId) throw new Error("CYCLE_CLIENT_RETRY_EXACT_BYTES_ONLY");
        await assertCycleWireResolved(connection, this.retained.pending, this.retained.signature);
        this.retained = null;
      }
      const wire = await signValidatedCycleStep({ connection, policy: reply.policy, record: reply.record, state: reply.state, pending, wallet: this.owner, metadata: this.options.metadata }, signTransaction, () => this.current());
      const signature = bs58.encode(VersionedTransaction.deserialize(Buffer.from(wire, "base64")).signatures[0]);
      // Keep this even if the wallet switched or the HTTP reply is lost. Never silently
      // discard it because a server summary omits a pending step.
      this.retained = { pending: structuredClone(pending), wire, signature };
      this.current();
      return this.call("submit", { signedTransaction: wire, request: cycleActionPurpose(pending.action) === "recovery" ? "withdraw" : "next" });
    });
  }
  async retry(): Promise<PublicCycleReply> {
    return this.work(async () => {
      const pending = this.retained?.pending ?? this.reply?.state.pending;
      const wire = this.retained?.wire ?? pending?.signedTransaction;
      if (!wire || !pending) throw new Error("CYCLE_CLIENT_NO_RETAINED_SIGNED_BYTES");
      return this.call("submit", { signedTransaction: wire, request: cycleActionPurpose(pending.action) === "recovery" ? "withdraw" : "next" });
    });
  }
}
