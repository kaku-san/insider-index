"use client";

import { useRef, useState } from "react";
import { usePrivySolana } from "./providers/privy-provider";
import { validateCycleAccessMessage, type CycleAccessChallenge, type CycleAccessProof } from "../lib/index-vaults/cycle-access-parse";
import { cycleActivationBlockers, cyclePolicyHash, type CyclePolicy } from "../lib/index-vaults/cycle-policy-parse";
import type { CycleState } from "../lib/index-vaults/cycle-store";
import type { PersistedVaultDefinition } from "../lib/index-vaults/vault-definition-store";

type Reply = { policy: CyclePolicy; challenge?: CycleAccessChallenge; record?: PersistedVaultDefinition; state?: CycleState; preparation?: { action: string; reason: string }; submission?: { signature: string; status: string }; error?: string; };
/** Deliberately private/manual owner controls. No auto-sign, public invest button, fixture
 * wallet, server key, balance-as-credit shortcut, or in-kind "USDC complete" claim. */
export function PrivateCycleAdmin() {
  const wallet = usePrivySolana();
  const [operationId, setOperationId] = useState("");
  const [reply, setReply] = useState<Reply | null>(null);
  const [auth, setAuth] = useState<CycleAccessProof | null>(null);
  const [busy, setBusy] = useState(false), [status, setStatus] = useState("Private operation configuration is required. Public funds remain disabled.");
  const running = useRef(false), signed = useRef(new Map<string, { stepId: string; wire: string }>());
  const rpc = process.env.NEXT_PUBLIC_SOLANA_RPC_URL?.trim();
  const policy = reply?.policy, state = reply?.state, pending = state?.pending;
  const liveOwner = wallet.mode === "live" && !wallet.previewConnection && !!wallet.solanaAddress && (!policy || policy.owner === wallet.solanaAddress);
  const canSpend = liveOwner && !!policy && cycleActivationBlockers(policy).length === 0 && policy.expiresAt > Date.now();
  async function work(task: () => Promise<void>) {
    if (running.current) return;
    running.current = true; setBusy(true);
    try { await task(); } catch (error) { setStatus(`${error instanceof Error ? error.message : "Operation refused"}. Retain this operation and reconcile; do not repeat funding or burn.`); }
    finally { running.current = false; setBusy(false); }
  }
  async function call(action: string, fields: Record<string, unknown> = {}, proof = auth): Promise<Reply> {
    const response = await fetch("/api/vaults/cycle", { method: "POST", headers: { "Content-Type": "application/json" }, cache: "no-store", body: JSON.stringify({ operationId, action, ...(action !== "challenge" ? { auth: proof } : {}), ...fields }) });
    const body = await response.json() as Reply;
    if (!response.ok || body.error) throw new Error(body.error ?? "CYCLE_REQUEST_FAILED");
    if (body.policy.operationId !== operationId || body.policy.owner !== wallet.solanaAddress || (policy && cyclePolicyHash(body.policy) !== cyclePolicyHash(policy))) throw new Error("CYCLE_CLIENT_POLICY_CHANGED_REVIEW_REQUIRED");
    setReply(body);
    if (body.state && body.state.pending?.stepId !== signed.current.get(operationId)?.stepId) signed.current.delete(operationId);
    return body;
  }
  async function review() {
    if (!liveOwner || !wallet.solanaAddress) throw new Error("Connect the approved live owner wallet");
    setAuth(null);
    await call("challenge", { wallet: wallet.solanaAddress });
    setStatus("Review the exact policy below. Access authorization is a message signature, not permission to spend.");
  }
  async function authorize() {
    if (!liveOwner || !wallet.solanaAddress || !policy || !reply?.challenge) throw new Error("Review this operation first");
    const message = validateCycleAccessMessage(reply.challenge, policy, window.location.origin, wallet.solanaAddress);
    const proof = { token: reply.challenge.token, signature: await wallet.signMessage(message) };
    setAuth(proof); await call("read", {}, proof);
    setStatus("Access authorized briefly. Prepare, inspect, then explicitly sign each owner step; a separate keeper performs stock execution.");
  }
  async function signStep() {
    if (!canSpend || !auth || !policy || !state || !reply?.record || !pending || pending.payer !== wallet.solanaAddress || pending.signature) throw new Error("No authorized unsigned owner step");
    if (!rpc) throw new Error("Configure a browser-visible read-only NEXT_PUBLIC_SOLANA_RPC_URL before signing");
    const [{ Connection, VersionedTransaction, PublicKey }, { validateCycleOwnerTransaction }, { sha256 }, { ed25519 }] = await Promise.all([import("@solana/web3.js"), import("../lib/frontend/cycle-wallet"), import("../lib/index-vaults/amounts"), import("@noble/curves/ed25519")]);
    const connection = new Connection(rpc, { commitment: "confirmed", disableRetryOnRateLimit: true });
    const validated = await validateCycleOwnerTransaction({ connection, policy, record: reply.record, state, pending, wallet: wallet.solanaAddress! });
    setStatus(`Validated ${pending.action}. Approve only the displayed exact owner transaction in your wallet.`);
    const wire = await wallet.signTransaction(pending.txBase64, "mainnet-beta"), transaction = VersionedTransaction.deserialize(Buffer.from(wire, "base64"));
    if (transaction.message.header.numRequiredSignatures !== 1 || sha256(transaction.message.serialize()) !== validated.messageHash || transaction.message.staticAccountKeys[0].toBase58() !== policy.owner || !ed25519.verify(transaction.signatures[0], transaction.message.serialize(), new PublicKey(policy.owner).toBytes(), { zip215: false })) throw new Error("CYCLE_WALLET_CHANGED_SIGNED_MESSAGE");
    // Retain exact bytes across an ambiguous HTTP response. Never ask for a replacement wire.
    signed.current.set(operationId, { stepId: pending.stepId, wire });
    const result = await call("submit", { signedTransaction: wire });
    setStatus(`Submitted ${result.submission?.signature ?? "exact signed message"}. Reconcile finalized evidence before the next step.`);
  }
  async function retry() {
    if (!liveOwner || !pending) throw new Error("No owner obligation to retry");
    const stored = signed.current.get(operationId), wire = pending.signedTransaction ?? (stored?.stepId === pending.stepId ? stored.wire : null);
    if (!wire) throw new Error("Signed bytes unavailable. Reconcile canonical history; never replace an issued draft.");
    await call("submit", { signedTransaction: wire }); setStatus("Retried only the exact retained bytes. Reconcile finality.");
  }
  return <section className="mt-10 space-y-4 rounded-xl border border-amber-500/30 p-5">
    <h2 className="text-xl font-semibold">Private native USDC cycle</h2>
    <p className="text-sm text-neutral-400">Operator-only, definition-driven workflow. Public funds remain off. Native settlement and issuer risks remain; no guaranteed return or loss protection. Do not fund until exit/recovery and exact budgets are separately approved.</p>
    <div className="flex flex-wrap gap-2">
      <button disabled={busy} onClick={() => void work(() => wallet.connect("wallet"))}>Connect owner wallet</button>
      <input aria-label="Approved private operation UUID" className="min-w-72 rounded border bg-transparent p-2" placeholder="Approved operation UUID" value={operationId} disabled={busy} onChange={e => { setOperationId(e.target.value.trim()); setReply(null); setAuth(null); }} />
      <button disabled={busy || !liveOwner || !operationId} onClick={() => void work(review)}>Review / renew access</button>
      <button disabled={busy || !liveOwner || !reply?.challenge} onClick={() => void work(authorize)}>Sign access message</button>
    </div>
    {policy && <details open><summary>Exact operator policy — verify before authorization</summary><pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all text-xs">{JSON.stringify(policy, null, 2)}</pre></details>}
    {state && <>
      <p className="text-sm">Phase: {state.phase} · Native shares minted/burned (raw): {state.mintedSharesRaw}/{state.burnedSharesRaw} · USDC contributed/recovered (raw): {state.contributedUsdcRaw}/{state.recoveredUsdcRaw}</p>
      <p className="text-xs text-neutral-400">These are operation receipt totals, not wallet NAV or balances. Native token accounts determine ownership. Withdrawal burns shares, then requires claim/conversion steps before USDC completion.</p>
      {state.recoveryRequired && <p role="alert">Recovery audit required: {state.recoveryRequired}</p>}
      <div className="flex flex-wrap gap-3">
        <button disabled={busy || !auth || !canSpend || !!pending} onClick={() => void work(async () => { const r = await call("prepare", { request: "next" }); setStatus(r.preparation?.reason ?? "Prepared owner step"); })}>Prepare next owner step</button>
        <button disabled={busy || !auth || !canSpend || !!pending || state.phase !== "holding"} onClick={() => void work(async () => { await call("prepare", { request: "withdraw" }); setStatus("Withdrawal prepared, not signed. Verify the burn and USDC exit minimum."); })}>Prepare USDC exit</button>
        <button disabled={busy || !auth || !canSpend || !!pending} onClick={() => void work(async () => { await call("prepare", { request: "recover" }); setStatus("Recovery step prepared; no implied refund or replacement deposit."); })}>Prepare recovery</button>
        <button disabled={busy || !auth} onClick={() => void work(async () => { await call("reconcile"); setStatus("Finalized history reconciled. Incomplete history retains the obligation; reconciliation may require repeated calls."); })}>Reconcile / resume</button>
      </div>
      {pending && <div className="space-y-2 break-all border-t pt-3 text-sm">
        <p>Pending: {pending.action} · Payer: {pending.payer} · Expires: {new Date(pending.expiresAt).toISOString()}</p>
        <p>Message: {pending.messageHash} · Exact input: {pending.exactInputRaw ?? "none"} · Minimum USDC output: {pending.minOutputRaw ?? "not a conversion"}</p>
        <p>Signature: {pending.signature ?? "not latched; issued drafts still require recovery evidence"}</p>
        <button disabled={busy || !auth || !canSpend || !rpc || pending.payer !== wallet.solanaAddress || !!pending.signature || pending.expiresAt <= Date.now()} onClick={() => void work(signStep)}>Validate independently & sign this step</button>{" "}
        <button disabled={busy || !auth || !liveOwner || pending.payer !== wallet.solanaAddress || !(pending.signedTransaction || signed.current.has(operationId))} onClick={() => void work(retry)}>Retry exact signed bytes</button>
      </div>}
    </>}
    <p role="status" className="text-sm text-amber-200">{busy ? "Working — do not start another operation. " : ""}{status}</p>
  </section>;
}
