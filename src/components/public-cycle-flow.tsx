"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { usePrivySolana } from "./providers/privy-provider";
import { cycleActionPurpose, cycleActivationBlockers } from "../lib/index-vaults/cycle-policy-parse";
import type { PublicCycleClient, PublicCycleDiscovery, PublicCycleReply } from "../lib/frontend/public-cycle";
import { publicCycleStatusCopy } from "../lib/frontend/public-cycle-copy";
import { publicCycleNextRequest, publicCyclePrimaryCta, publicDepositAmountRaw } from "../lib/frontend/public-cycle-controls";
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
  const canRetry = !!pending && pending.payer === liveOwner && !!(pending.signedTransaction || (retained?.owner === liveOwner && retained.stepId === pending.stepId));
  let amountRaw: string | null = null;
  try { amountRaw = publicDepositAmountRaw(amount); } catch { /* The primary action stays disabled until this is valid. */ }
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
    catch (error) {
      const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : null;
      if (process.env.NODE_ENV !== "production" && code) console.warn("Public cycle request failed", { code });
      if (code === "CYCLE_AUTHORIZATION_EXPIRED") { setDiscovery(null); setReply(null); }
      const copy = publicCycleStatusCopy(error, mode);
      setStatus(process.env.NODE_ENV === "development" && code ? `${copy} [${code}]` : copy);
    }
    finally {
      const owner = currentOwner.current, stepId = owner ? sessions.current.get(owner)?.retainedStepId : null;
      setRetained(owner && stepId ? { owner, stepId } : null);
      running.current = false; setBusy(false);
    }
  }
  async function prepare(request: "next" | "withdraw" | "recover") {
    setStatus(request === "withdraw" || request === "recover" || mode === "withdraw" ? "Preparing your cash out." : "Preparing your investment.");
    const result = await (await client()).prepare(request);
    setReply(result);
    setStatus(result.state.phase === "complete"
      ? "Cash out complete. Your USDC is in your wallet."
      : result.preparation?.action === "wait"
        ? "Still processing. Refresh to check progress."
        : request === "withdraw" || request === "recover" || mode === "withdraw"
          ? "Your cash out is ready. Sign in your wallet."
          : "Your investment is ready. Sign in your wallet.");
  }
  const sharesLabel = ownedSharesLabel(position);
  const nextRequest = state ? publicCycleNextRequest(mode, state, newDeposits) : null;
  const exitInProgress = state?.phase === "exiting" || state?.phase === "recovering";
  const primary = publicCyclePrimaryCta({
    mode,
    walletConnected: !!liveOwner,
    accessReady,
    authorized: !!policy,
    pending: !!pending,
    canRetry,
    nextRequest,
  });
  const primaryDisabled = !primary || busy
    || (primary.action === "discover" && mode === "deposit" && !amountRaw)
    || (primary.action === "prepare" && (!active || (nextRequest === "next" && !exitInProgress && !newDeposits)))
    || (primary.action === "sign" && !canSign)
    || (primary.action === "retry" && !canRetry);
  async function runPrimary() {
    if (!primary) return;
    if (primary.action === "connect") {
      setStatus("Opening your wallet connection.");
      await wallet.connect("wallet");
      setStatus("Choose an amount to review.");
      return;
    }
    if (primary.action === "discover") {
      setStatus(mode === "deposit" ? "Reviewing your amount." : "Loading your cash out details.");
      setDiscovery(await (await client()).discover(mode === "deposit" ? amountRaw ?? undefined : undefined));
      setStatus("Confirm in your wallet to continue.");
      return;
    }
    if (primary.action === "authorize") {
      setStatus("Confirm in your wallet to continue.");
      const result = await (await client()).authorize(wallet.signMessage);
      setReply(result);
      if (mode === "deposit" && result.depositEnabled && !result.state.pending && result.state.phase !== "complete") {
        await prepare("next");
        return;
      }
      setStatus(mode === "deposit"
        ? result.depositEnabled ? "Investment details are ready. Prepare investment to continue." : "Investment details are ready. Investing isn't open right now."
        : "Cash out details are ready. Cash out to USDC to continue.");
      return;
    }
    if (primary.action === "prepare") {
      if (!nextRequest) throw new Error("CYCLE_PUBLIC_OPERATION_REFUSED");
      await prepare(nextRequest);
      return;
    }
    if (primary.action === "retry") {
      setStatus("Retrying your signed action.");
      setReply(await (await client()).retry());
      setStatus("Still processing. Refresh to check progress.");
      return;
    }
    setStatus("Sign in your wallet to continue.");
    setReply(await (await client()).signStep(wallet.signTransaction));
    setStatus("Signed. We’ll update this when it finishes.");
  }
  return <div className="space-y-4">
    <div className={styles.intro}><h3>{mode === "withdraw" ? "Cash out to USDC" : "Invest"}</h3><p>{mode === "withdraw" ? "Convert your shares to USDC. Keep going until every step is complete." : "Choose your USDC amount, then review before you sign."}</p></div>
    {mode === "deposit" && <>
      <p className={styles.notice}>Alpha: funds are at risk. Shares and cash out can take multiple approvals; returns are not guaranteed.</p>
      {liveOwner && <div className={styles.amountWrap}><label htmlFor="public-deposit-amount">Amount in USDC</label><div className={styles.amount}><input id="public-deposit-amount" inputMode="decimal" autoComplete="off" placeholder="0.00" value={amount} disabled={busy || accessReady} onChange={event => setAmount(event.target.value)} /></div></div>}
    </>}
    {sharesLabel ? <div className={styles.summary}><div className={styles.row}><span>Your position</span><strong>{sharesLabel}</strong></div></div> : null}
    {policy && <>
      {!newDeposits && mode === "deposit" && <div className={styles.blockers}>Investing is not open right now.</div>}
      {state && <>
        {mode === "deposit" ? <div className={styles.summary}><div className={styles.row}><span>You invest</span><strong>{usdcText(policy.limits.depositUsdcRaw)}</strong></div><div className={styles.row}><span>Expected shares</span><strong>Confirmed when your purchase finishes</strong></div></div> : <div className={styles.summary}><div className={styles.row}><span>Minimum cash out</span><strong>{usdcText(policy.limits.minExitUsdcRaw)} USDC</strong></div></div>}
        {state.recoveryRequired && <div role="alert" className={styles.blockers}>This action needs attention before you continue.</div>}
        {pending && <div className={styles.approval}>
          <h4>{cycleActionPurpose(pending.action) === "recovery" ? "Cash out ready to sign" : "Investment ready to sign"}</h4><p>{pending.payer === liveOwner ? "Check the amount in your wallet, then sign." : "Your purchase is being completed."}</p>
        </div>}
      </>}
    </>}
    <div className={styles.cta}>
      {primary && <button className={styles.primary} disabled={primaryDisabled} onClick={() => void work(runPrimary)}>{primary.label}</button>}
      {policy && <button className={styles.secondary} disabled={busy} onClick={() => void work(async () => { setStatus("Refreshing your investment status."); setReply(await (await client()).reconcile()); setStatus("Your latest update is here."); })}>Refresh</button>}
    </div>
    <p role="status" className={styles.notice}>{busy ? "Working. " : ""}{status}</p>
  </div>;
}
