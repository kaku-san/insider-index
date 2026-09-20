"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { usePrivySolana } from "./providers/privy-provider";
import { cycleActionPurpose, cycleActivationBlockers } from "../lib/index-vaults/cycle-policy-parse";
import type { PublicCycleClient, PublicCycleDiscovery, PublicCycleReply } from "../lib/frontend/public-cycle";
import { publicCycleErrorCopy } from "../lib/frontend/public-cycle-copy";
import { publicDepositAmountRaw, publicCycleNextRequest } from "../lib/frontend/public-cycle-controls";
import { hasIndexShares, type IndexSharePosition } from "../lib/frontend/vault-api";
import { formatVaultShares } from "../lib/index-vaults/positions-contract";
import styles from "./vault-flow.module.css";

function usdcText(raw: string) {
  if (!/^(0|[1-9]\d*)$/.test(raw)) return "Unavailable";
  const padded = raw.padStart(7, "0"), whole = padded.slice(0, -6), fraction = padded.slice(-6).replace(/0+$/, "");
  return `$${Number(whole).toLocaleString()}${fraction ? `.${fraction}` : ""}`;
}

/** Native lifecycle controls only. Page tabs, index copy and layout remain separate. */
function ownedSharesLabel(position?: IndexSharePosition | null) {
  try {
    if (!hasIndexShares(position) || !position) return null;
    return `${formatVaultShares(position.sharesRaw, position.shareDecimals ?? 0)} shares`;
  } catch { return null; }
}

export function PublicCycleFlow({ mode, position }: { mode: "deposit" | "withdraw"; position?: IndexSharePosition | null }) {
  const wallet = usePrivySolana();
  const [reply, setReply] = useState<PublicCycleReply | null>(null);
  const [discovery, setDiscovery] = useState<PublicCycleDiscovery | null>(null);
  const [busy, setBusy] = useState(false), [now, setNow] = useState(0);
  const [amount, setAmount] = useState("");
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
    if (!liveOwner) throw new Error("Connect your wallet.");
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
    catch (e) { setStatus(publicCycleErrorCopy(e, mode)); }
    finally {
      const owner = currentOwner.current, stepId = owner ? sessions.current.get(owner)?.retainedStepId : null;
      setRetained(owner && stepId ? { owner, stepId } : null);
      running.current = false; setBusy(false);
    }
  }
  async function prepare(request: "next" | "withdraw" | "recover") {
    const result = await (await client()).prepare(request); setReply(result); setStatus(result.state.phase === "complete" ? "Cash out complete. Your USDC is in your wallet." : result.preparation?.action === "wait" ? "Still processing. Refresh to check progress." : "Ready to sign.");
  }
  const sharesLabel = ownedSharesLabel(position);
  const nextRequest = state ? publicCycleNextRequest(mode, state) : null;
  const exitInProgress = state?.phase === "exiting" || state?.phase === "recovering";
  return <div className="space-y-4">
    <div className={styles.intro}><h3>{mode === "withdraw" ? "Cash out to USDC" : "Invest"}</h3><p>{mode === "withdraw" ? "Convert your shares to USDC. Keep going until every step is complete." : "Choose your USDC amount, then review before you sign."}</p></div>
    {mode === "deposit" && <><p className={styles.notice}>Alpha: funds are at risk. Shares and cash out can take multiple approvals; returns are not guaranteed.</p>{!accessReady && <div className={styles.amountWrap}><label htmlFor="public-deposit-amount">Amount in USDC</label><div className={styles.amount}><input id="public-deposit-amount" inputMode="decimal" autoComplete="off" placeholder="0.00" value={amount} disabled={busy} onChange={event => setAmount(event.target.value)} /></div></div>}</>}
    {sharesLabel ? <div className={styles.summary}><div className={styles.row}><span>Your position</span><strong>{sharesLabel}</strong></div></div> : null}
    <div className={styles.cta}>
      {!liveOwner ? <button className={styles.primary} disabled={busy} onClick={() => void work(() => wallet.connect("wallet"))}>Connect wallet</button> : <button className={styles.primary} disabled={busy} onClick={() => void work(async () => { const c = await client(); setDiscovery(await c.discover(mode === "deposit" && !accessReady ? publicDepositAmountRaw(amount) : undefined)); setStatus("Continue in your wallet."); })}>{mode === "deposit" && !accessReady ? "Review amount" : "Continue"}</button>}
      {liveOwner && !accessReady && mode === "deposit" && <button className={styles.secondary} disabled={busy} onClick={() => void work(async () => { setDiscovery(await (await client()).discover()); setStatus("Continue in your wallet to resume."); })}>Resume</button>}
      <button className={styles.primary} disabled={busy || !accessReady} onClick={() => void work(async () => { const c = await client(); setReply(await c.authorize(wallet.signMessage)); setStatus("Your investment details are ready."); })}>Continue</button>
    </div>
    {policy && <>
      {!newDeposits && mode === "deposit" && <div className={styles.blockers}>Investing is not open right now.</div>}
      {state && <>
        {mode === "deposit" ? <div className={styles.summary}><div className={styles.row}><span>You invest</span><strong>{usdcText(policy.limits.depositUsdcRaw)}</strong></div><div className={styles.row}><span>Expected shares</span><strong>Confirmed when your purchase finishes</strong></div></div> : <div className={styles.summary}><div className={styles.row}><span>Minimum cash out</span><strong>{usdcText(policy.limits.minExitUsdcRaw)} USDC</strong></div></div>}
        {state.recoveryRequired && <div role="alert" className={styles.blockers}>This action needs attention before you continue.</div>}
        <div className={styles.cta}>
          <button className={styles.secondary} disabled={busy} onClick={() => void work(async () => { setReply(await (await client()).reconcile()); setStatus("Your latest update is here."); })}>Refresh</button>
          {nextRequest && <button className={styles.primary} disabled={busy || !active || (nextRequest === "next" && !exitInProgress && !newDeposits)} onClick={() => void work(() => prepare(nextRequest))}>{nextRequest === "withdraw" ? "Cash out to USDC" : exitInProgress ? "Continue to USDC" : "Continue"}</button>}
        </div>
        {pending && <div className={styles.approval}>
          <h4>{cycleActionPurpose(pending.action) === "recovery" ? "Continue cash out to USDC" : "Ready to invest"}</h4><p>{pending.payer === liveOwner ? "Check the amount in your wallet, then sign." : "Your purchase is being completed."}</p>
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
