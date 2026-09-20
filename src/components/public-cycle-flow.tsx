"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { usePrivySolana } from "./providers/privy-provider";
import { cycleActionPurpose, cycleActivationBlockers } from "../lib/index-vaults/cycle-policy-parse";
import type { PublicCycleClient, PublicCycleDiscovery, PublicCycleReply } from "../lib/frontend/public-cycle";
import styles from "./vault-flow.module.css";

function usdcText(raw: string) {
  if (!/^(0|[1-9]\d*)$/.test(raw)) return "Unavailable";
  const padded = raw.padStart(7, "0"), whole = padded.slice(0, -6), fraction = padded.slice(-6).replace(/0+$/, "");
  return `$${Number(whole).toLocaleString()}${fraction ? `.${fraction}` : ""}`;
}

/** Native lifecycle controls only. Page tabs, index copy and layout remain separate. */
export function PublicCycleFlow({ mode }: { mode: "deposit" | "withdraw" }) {
  const wallet = usePrivySolana();
  const [reply, setReply] = useState<PublicCycleReply | null>(null);
  const [discovery, setDiscovery] = useState<PublicCycleDiscovery | null>(null);
  const [busy, setBusy] = useState(false), [now, setNow] = useState(0);
  const [retained, setRetained] = useState<{ owner: string; stepId: string } | null>(null);
  const [status, setStatus] = useState("Connect your wallet to continue.");
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
    const result = await (await client()).prepare(request); setReply(result); setStatus(result.preparation?.action === "wait" ? "Your purchase is still being completed." : "Ready to sign.");
  }
  return <div className="space-y-4">
    <div className={styles.intro}><h3>{mode === "withdraw" ? "Cash out" : "Invest in one step"}</h3><p>{mode === "withdraw" ? "Cash out the shares you own." : "See your amount and share estimate before you sign."}</p></div>
    <div className={styles.cta}>
      {!liveOwner ? <button className={styles.primary} disabled={busy} onClick={() => void work(() => wallet.connect("wallet"))}>Connect wallet</button> : <button className={styles.primary} disabled={busy} onClick={() => void work(async () => { const c = await client(); setDiscovery(await c.discover()); setStatus("Continue in your wallet."); })}>Continue</button>}
      <button className={styles.primary} disabled={busy || !accessReady} onClick={() => void work(async () => { const c = await client(); setReply(await c.authorize(wallet.signMessage)); setStatus("Your investment details are ready."); })}>Continue</button>
    </div>
    {policy && <>
      {!newDeposits && mode === "deposit" && <div className={styles.blockers}>Investing is not open right now.</div>}
      {state && <>
        {mode === "deposit" ? <div className={styles.summary}><div className={styles.row}><span>You invest</span><strong>{usdcText(policy.limits.depositUsdcRaw)}</strong></div><div className={styles.row}><span>Expected shares</span><strong>Confirmed when your purchase finishes</strong></div></div> : <div className={styles.summary}><div className={styles.row}><span>Your cash out</span><strong>Shares you own</strong></div></div>}
        {state.recoveryRequired && <div role="alert" className={styles.blockers}>This action needs attention before you continue.</div>}
        <div className={styles.cta}>
          <button className={styles.secondary} disabled={busy} onClick={() => void work(async () => { setReply(await (await client()).reconcile()); setStatus("Your latest update is here."); })}>Refresh</button>
          {state.recoveryRequired ? <button className={styles.primary} disabled={busy || !active || !!pending} onClick={() => void work(() => prepare("recover"))}>Continue</button> : null}
          {mode === "deposit" && !state.recoveryRequired ? <button className={styles.primary} disabled={busy || !active || !!pending || (!newDeposits && !["exiting", "recovering"].includes(state.phase)) || state.phase === "complete"} onClick={() => void work(() => prepare("next"))}>Continue</button> : null}
          {mode === "withdraw" && !state.recoveryRequired ? <button className={styles.primary} disabled={busy || !active || !!pending || state.phase !== "holding"} onClick={() => void work(() => prepare("withdraw"))}>Cash out</button> : null}
        </div>
        {pending && <div className={styles.approval}>
          <h4>{mode === "deposit" ? "Ready to invest" : "Ready to cash out"}</h4><p>{pending.payer === liveOwner ? "Check the amount in your wallet, then sign." : "Your purchase is being completed."}</p>
          <div className={styles.cta}>
            <button className={styles.primary} disabled={busy || !canSign} onClick={() => void work(async () => { const c = await client(); setReply(await c.signStep(wallet.signTransaction)); setStatus("Signed. We’ll update this when it finishes."); })}>Sign</button>
            <button className={styles.secondary} disabled={busy || pending.payer !== liveOwner || !(pending.signedTransaction || (retained?.owner === liveOwner))} onClick={() => void work(async () => { setReply(await (await client()).retry()); setStatus("Still working on your signed action."); })}>Try again</button>
          </div>
        </div>}
      </>}
    </>}
    <p role="status" className={styles.notice}>{busy ? "Working. " : ""}{status}</p>
  </div>;
}
