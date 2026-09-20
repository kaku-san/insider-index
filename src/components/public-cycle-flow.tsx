"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePrivySolana } from "./providers/privy-provider";
import { cycleActionPurpose, cycleActivationBlockers } from "../lib/index-vaults/cycle-policy-parse";
import type { PublicCycleClient, PublicCycleDiscovery, PublicCycleReply } from "../lib/frontend/public-cycle";
import styles from "./vault-flow.module.css";

/** Native lifecycle controls only. Page tabs, index copy and layout remain separate. */
export function PublicCycleFlow({ mode }: { mode: "deposit" | "withdraw" }) {
  const wallet = usePrivySolana();
  const [reply, setReply] = useState<PublicCycleReply | null>(null);
  const [discovery, setDiscovery] = useState<PublicCycleDiscovery | null>(null);
  const [busy, setBusy] = useState(false), [now, setNow] = useState(0);
  const [retained, setRetained] = useState<{ owner: string; stepId: string } | null>(null);
  const [status, setStatus] = useState("A configured, wallet-bound Mag7 policy is required. Connecting never spends funds.");
  const sessions = useRef(new Map<string, PublicCycleClient>()), running = useRef(false);
  const liveOwner = wallet.mode === "live" && !wallet.previewConnection ? wallet.solanaAddress : null;
  const currentOwner = useRef(liveOwner);
  useLayoutEffect(() => { currentOwner.current = liveOwner; return () => { currentOwner.current = null; }; }, [liveOwner]);
  useEffect(() => { const update = () => setNow(Date.now()); update(); const timer = setInterval(update, 1000); return () => clearInterval(timer); }, []);
  const policy = reply?.policy.owner === liveOwner ? reply.policy : null;
  const state = policy ? reply!.state : null, pending = state?.pending;
  const accessReady = discovery?.binding.owner === liveOwner;
  const active = !!policy && cycleActivationBlockers(policy).length === 0 && policy.expiresAt > now;
  const newDeposits = active && reply?.depositEnabled === true;
  const canSign = active && !!pending && pending.payer === liveOwner && !pending.signature && pending.expiresAt > now && !(retained?.owner === liveOwner && retained.stepId === pending.stepId) && (cycleActionPurpose(pending.action) === "recovery" || newDeposits);
  async function client() {
    if (!liveOwner) throw new Error("Connect the approved live owner wallet.");
    let session = sessions.current.get(liveOwner);
    if (!session) {
      const { PublicCycleClient } = await import("../lib/frontend/public-cycle");
      const owner = liveOwner;
      session = new PublicCycleClient(owner, window.location.origin, { isCurrent: () => currentOwner.current === owner });
      sessions.current.set(owner, session);
    }
    return session;
  }
  async function work(task: () => Promise<void>) {
    if (running.current) return;
    running.current = true; setBusy(true);
    try { await task(); }
    catch (e) { setStatus(`${e instanceof Error ? e.message : "Operation refused"}. Keep this operation; reconcile instead of repeating funding or burn.`); }
    finally {
      const owner = currentOwner.current, stepId = owner ? sessions.current.get(owner)?.retainedStepId : null;
      setRetained(owner && stepId ? { owner, stepId } : null);
      running.current = false; setBusy(false);
    }
  }
  async function prepare(request: "next" | "withdraw" | "recover") {
    const result = await (await client()).prepare(request); setReply(result); setStatus(result.preparation?.reason ?? "Prepared, not signed.");
  }
  return <div className="space-y-4">
    <div className={styles.intro}><h3>{mode === "withdraw" ? "USDC exit" : "Mag7 native vault"}</h3><p>Review the exact approved policy, then approve each owner transaction separately. The dedicated external keeper executes stock settlement. This is not a guaranteed return or loss-protected product.</p></div>
    <div className={styles.cta}>
      {!liveOwner ? <button className={styles.primary} disabled={busy} onClick={() => void work(() => wallet.connect("wallet"))}>Connect wallet</button> : <button className={styles.secondary} disabled={busy} onClick={() => void work(async () => { const c = await client(); setDiscovery(await c.discover()); setStatus("Review the access-only message. It does not authorize a financial transaction."); })}>Find / renew approved operation</button>}
      <button className={styles.primary} disabled={busy || !accessReady} onClick={() => void work(async () => { const c = await client(); setReply(await c.authorize(wallet.signMessage)); setStatus("Review all policy limits below before preparing an owner action."); })}>Authorize access</button>
    </div>
    {accessReady && discovery && <p className="break-all text-xs">Operation: {discovery.binding.operationId} · Policy: {discovery.binding.policyHash}</p>}
    {policy && <>
      <details open><summary>Approved amounts, costs and risk limits</summary><pre className="max-h-72 overflow-auto whitespace-pre-wrap break-all text-xs">{JSON.stringify(policy, null, 2)}</pre></details>
      {!newDeposits && <div className={styles.blockers}>New public deposits are gated. A complete active policy, per-vault readiness and public release are all required. Existing obligations remain readable and resumable; no limits are supplied by this UI.</div>}
      {state && <>
        <div className={styles.summary}><div className={styles.row}><span>Operation phase</span><strong>{state.phase}</strong></div><div className={styles.row}><span>USDC contributed / recovered (raw)</span><strong>{state.contributedUsdcRaw} / {state.recoveredUsdcRaw}</strong></div><div className={styles.row}><span>Shares minted / burned (raw)</span><strong>{state.mintedSharesRaw} / {state.burnedSharesRaw}</strong></div></div>
        <p className="text-xs">These are operation receipt totals, not balances or NAV. Native share-token accounts determine ownership. Exit completes only after claims and attributable-credit USDC conversion, not merely after the share burn.</p>
        {state.recoveryRequired && <div role="alert" className={styles.blockers}>{state.recoveryRequired}</div>}
        <div className={styles.cta}>
          <button className={styles.secondary} disabled={busy} onClick={() => void work(async () => { setReply(await (await client()).reconcile()); setStatus("Finalized receipts reconciled. Missing history retains the existing obligation."); })}>Reconcile / refresh</button>
          <button className={styles.primary} disabled={busy || !active || !!pending || (!newDeposits && !["exiting", "recovering"].includes(state.phase)) || state.phase === "complete"} onClick={() => void work(() => prepare("next"))}>Prepare next owner step</button>
        </div>
        <div className={styles.cta}>
          <button className={styles.secondary} disabled={busy || !active || !!pending || state.phase !== "holding"} onClick={() => void work(() => prepare("withdraw"))}>Prepare approved USDC exit</button>
          <button className={styles.secondary} disabled={busy || !active || !!pending || state.phase === "complete"} onClick={() => void work(() => prepare("recover"))}>Prepare recovery</button>
        </div>
        {pending && <div className={styles.approval}>
          <h4>{pending.action}</h4><p className="break-all">Payer: {pending.payer}<br/>Message: {pending.messageHash}<br/>Exact input (raw): {pending.exactInputRaw ?? "none"}<br/>Minimum USDC output (raw): {pending.minOutputRaw ?? "not a conversion"}<br/>Signature: {pending.signature ?? "not latched"}</p>
          {pending.payer !== liveOwner && <p>This is a keeper step, not an owner wallet approval.</p>}
          <div className={styles.cta}>
            <button className={styles.primary} disabled={busy || !canSign} onClick={() => void work(async () => { const c = await client(); setReply(await c.signStep(wallet.signTransaction)); setStatus("Exact signed bytes submitted through the durable journal. Reconcile finality before continuing."); })}>Validate independently & sign</button>
            <button className={styles.secondary} disabled={busy || pending.payer !== liveOwner || !(pending.signedTransaction || (retained?.owner === liveOwner))} onClick={() => void work(async () => { setReply(await (await client()).retry()); setStatus("Retried only the retained signed bytes."); })}>Retry exact signed bytes</button>
          </div>
        </div>}
      </>}
    </>}
    <p role="status" className={styles.notice}>{busy ? "Working. " : ""}{status}</p>
    <Link className="text-xs underline" prefetch={false} href="/indexes/idx-theme-mag7-caucus?nativeCycle=resume">Bookmark the public resume / exit link</Link>
  </div>;
}
