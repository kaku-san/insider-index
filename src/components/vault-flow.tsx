"use client";

import { useEffect, useRef, useState } from "react";
import { usePrivySolana } from "./providers/privy-provider";
import { WalletConnectSheet } from "./wallet-connect-sheet";
import { Icon } from "./social/icon";
import { SettlementListen } from "./settlement-listen";

import { PUBLIC_DEPOSIT_MINIMUM_USDC_RAW, publicDepositMinimumMessage } from "@/lib/index-vaults/deposit-floor";
import {
  depositIsEnabled, getIndexPosition, prepareDeposit, prepareWithdrawal,
  type IndexSharePosition, type PreparedStep, type VaultReadiness,
} from "@/lib/frontend/vault-api";
import {
  SETTLEMENT_POLL_MS, SETTLEMENT_POLL_TIMEOUT_MS, settlementDetail, settlementView, sharesIncreasedAfterSignature,
  type SettlementView,
} from "@/lib/frontend/settlement-progress";
import { CASH_OUT_BEFORE_SIGN, CASH_OUT_CHECK, CASH_OUT_STILL_NOTE, cashOutDeliveryOf, humanPrepareMessage, MAG7_FILL_CHECK, prepareCheckControl, prepareRequestKey, withPrepareTimeout, type PrepareCheckStatus } from "@/lib/frontend/position-basket";
import { CashOutDeliveryStatus } from "./position-book";
import styles from "./vault-flow.module.css";

export { sharesIncreasedAfterSignature };

type Mode = "deposit" | "withdraw";
type Screen = "amount" | "prepare" | "approval" | "submitted";
const DEPOSIT_PRESETS = [1, 5, 10, 25, 50] as const;
type PreparedQuote = { step: PreparedStep; requestKey: string };

function decimalToRaw(text: string, decimals: number, label: string) {
  const value = text.trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) throw new Error(`Enter a valid ${label} amount.`);
  const [whole, fraction = ""] = value.split(".");
  if (fraction.length > decimals) throw new Error(`${label} supports at most ${decimals} decimal places.`);
  const raw = BigInt(whole) * 10n ** BigInt(decimals) + BigInt((fraction + "0".repeat(decimals)).slice(0, decimals) || "0");
  if (raw <= 0n) throw new Error(`Enter a ${label} amount greater than zero.`);
  return raw.toString();
}
function usdcRaw(text: string) { return decimalToRaw(text, 6, "USDC"); }
function rawToDecimal(rawText: string, decimals: number) {
  if (!/^(?:0|[1-9]\d*)$/.test(rawText)) throw new Error("The share balance is invalid.");
  const padded = rawText.padStart(decimals + 1, "0"), whole = decimals ? padded.slice(0, -decimals) : padded;
  const fraction = decimals ? padded.slice(-decimals).replace(/0+$/, "") : "";
  return fraction ? `${whole}.${fraction}` : whole;
}
function withdrawalDecimals(readiness?: VaultReadiness | null, position?: IndexSharePosition | null) {
  const decimals = position?.shareDecimals ?? readiness?.identity?.shareDecimals ?? readiness?.vault?.shareDecimals;
  if (!Number.isInteger(decimals) || decimals! < 0 || decimals! > 18) throw new Error("Cash out is not available until your share details refresh.");
  return decimals as number;
}
function positionSharesText(position?: IndexSharePosition | null) {
  if (!position) return null;
  if (position.sharesText) return position.sharesText;
  try { return typeof position.shareDecimals === "number" ? rawToDecimal(position.sharesRaw, position.shareDecimals) : null; } catch { return null; }
}
function pendingIntent(position?: IndexSharePosition | null) { return position?.pendingOperations?.find(operation => !operation.complete) ?? null; }
function sawWithdraw(position?: IndexSharePosition | null) {
  return Boolean(position?.pendingOperations?.some(operation => operation.kind === "withdraw" && operation.complete !== true && operation.phase !== "FAILED"));
}
async function confirmSignature(signature: string, network: "mainnet-beta" | "devnet") {
  const endpoint = network === "devnet" ? "https://api.devnet.solana.com" : `${window.location.origin}/api/rpc`;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: `vault-confirm-${attempt}`, method: "getSignatureStatuses", params: [[signature], { searchTransactionHistory: true }] }) });
    if (!response.ok) throw new Error("Transaction confirmation is unavailable.");
    const payload = await response.json() as { error?: { message?: string }; result?: { value?: Array<{ confirmationStatus?: string | null; err?: unknown } | null> } };
    if (payload.error) throw new Error(payload.error.message || "Transaction confirmation failed.");
    const status = payload.result?.value?.[0];
    if (status?.err) throw new Error("The wallet transaction failed on chain.");
    if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") return;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error("Transaction confirmation timed out.");
}

export function VaultFlow({ open, onClose, indexId, indexName, readiness, mode = "deposit", position, onPosition }: { open: boolean; onClose: () => void; indexId: string; indexName: string; readiness?: VaultReadiness | null; mode?: Mode; position?: IndexSharePosition | null; indexKind?: "person" | "theme"; onPosition?: (position: IndexSharePosition | null) => void }) {
  const wallet = usePrivySolana();
  const [screen, setScreen] = useState<Screen>("amount");
  const [amount, setAmount] = useState(() => mode === "deposit" ? "1" : positionSharesText(position) ?? "0");
  const [prepared, setPrepared] = useState<PreparedQuote | null>(null);
  const [settlementPosition, setSettlementPosition] = useState<IndexSharePosition | null>(null);
  const [sharesBeforeSignature, setSharesBeforeSignature] = useState(position?.sharesRaw ?? "0");
  const [sawWithdrawPending, setSawWithdrawPending] = useState(false);
  const [timedOut, setTimedOut] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [availableUsdcRaw, setAvailableUsdcRaw] = useState<string | null>(null);
  const [connectOpen, setConnectOpen] = useState(false);
  const [quoteStatus, setQuoteStatus] = useState<PrepareCheckStatus>("idle");
  const quoteGeneration = useRef(0);
  const sawWithdrawRef = useRef(false);
  const onPositionRef = useRef(onPosition);
  onPositionRef.current = onPosition;
  const activeIntent = pendingIntent(position);
  const currentShares = positionSharesText(position);
  const network = readiness?.identity?.network ?? readiness?.vault?.network;
  const hasVault = Boolean(readiness?.identity || readiness?.vault);
  const canPrepare = hasVault && (mode === "deposit" ? depositIsEnabled(readiness) : readiness?.redeemEnabled === true) && !activeIntent;
  let requestedUsdcRaw: string | null = null;
  try { requestedUsdcRaw = mode === "deposit" ? usdcRaw(amount) : null; } catch { /* start surfaces exact validation copy */ }
  const insufficientUsdc = mode === "deposit" && requestedUsdcRaw !== null && availableUsdcRaw !== null && BigInt(requestedUsdcRaw) > BigInt(availableUsdcRaw);
  const displayed: Screen = screen === "amount" && activeIntent ? "submitted" : screen;
  const observedPosition = settlementPosition ?? (displayed === "submitted" ? position ?? null : null);
  const view: SettlementView = settlementView({
    mode, sharesBeforeRaw: sharesBeforeSignature, position: observedPosition, timedOut: mode === "deposit" && timedOut, sawWithdrawPending: sawWithdrawPending || sawWithdraw(observedPosition),
  });

  // eslint-disable-next-line react-hooks/set-state-in-effect, react-hooks/exhaustive-deps
  useEffect(() => {
    if (!open) return;
    const pending = pendingIntent(position);
    sawWithdrawRef.current = sawWithdraw(position);
    setScreen(pending ? "submitted" : "amount");
    setPrepared(null);
    setSettlementPosition(pending ? position ?? null : null);
    setSharesBeforeSignature(position?.sharesRaw ?? "0");
    setSawWithdrawPending(sawWithdrawRef.current);
    setTimedOut(false);
    setError(null);
    setAvailableUsdcRaw(null);
    setAmount(mode === "deposit" ? "1" : positionSharesText(position) ?? "0");
    setQuoteStatus("idle");
    quoteGeneration.current += 1;
  }, [open, mode, indexId]);
  useEffect(() => {
    if (!open || screen !== "amount" || mode !== "deposit" || !wallet.solanaAddress || !network) return;
    let alive = true;
    const endpoint = network === "devnet" ? "https://api.devnet.solana.com" : `${window.location.origin}/api/rpc`;
    void fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: "usdc-balance", method: "getTokenAccountsByOwner", params: [wallet.solanaAddress, { mint: network === "devnet" ? "USDCoctVLVnvTXBEuP9s8hntucdJokbo17RwHuNXemT" : "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" }, { encoding: "jsonParsed", commitment: "confirmed" }] }) })
      .then(response => response.ok ? response.json() : null).then(payload => {
        const accounts = payload?.result?.value; if (!alive || !Array.isArray(accounts)) return;
        let total = 0n; for (const account of accounts) { const raw = account?.account?.data?.parsed?.info?.tokenAmount?.amount; if (typeof raw !== "string" || !/^(0|[1-9]\d*)$/.test(raw)) return; total += BigInt(raw); }
        setAvailableUsdcRaw(total.toString());
      }).catch(() => {});
    return () => { alive = false; };
  }, [open, screen, mode, wallet.solanaAddress, network]);
  // An already-open sheet should switch to the listener when a pending read appears.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => {
    if (open && activeIntent) setScreen("submitted");
  }, [open, activeIntent]);
  useEffect(() => {
    if (!open || !wallet.solanaAddress || (screen !== "submitted" && !activeIntent)) return;
    let alive = true, timer: ReturnType<typeof setTimeout> | null = null;
    const deadline = Date.now() + SETTLEMENT_POLL_TIMEOUT_MS;
    const observe = () => void getIndexPosition(indexId, wallet.solanaAddress!).then(value => {
      if (!alive) return;
      if (sawWithdraw(value)) sawWithdrawRef.current = true;
      const expired = mode === "deposit" && Date.now() >= deadline;
      setSawWithdrawPending(sawWithdrawRef.current);
      if (expired) setTimedOut(true);
      setSettlementPosition(value);
      onPositionRef.current?.(value);
      const next = settlementView({ mode, sharesBeforeRaw: sharesBeforeSignature, position: value, timedOut: expired, sawWithdrawPending: sawWithdrawRef.current });
      if (next.listening) timer = setTimeout(observe, SETTLEMENT_POLL_MS);
    }).catch(() => {
      if (!alive) return;
      if (mode === "deposit" && Date.now() >= deadline) setTimedOut(true);
      else timer = setTimeout(observe, SETTLEMENT_POLL_MS);
    });
    observe();
    return () => { alive = false; if (timer) clearTimeout(timer); };
  }, [open, screen, mode, indexId, wallet.solanaAddress, sharesBeforeSignature]);

  function availableUsdcText() { return availableUsdcRaw === null ? "—" : rawToDecimal(availableUsdcRaw, 6); }
  function changeAmount(next: string) {
    quoteGeneration.current += 1;
    setPrepared(null);
    setQuoteStatus("idle");
    setAmount(next);
  }
  function useMaxUsdc() { if (availableUsdcRaw !== null) changeAmount(rawToDecimal(availableUsdcRaw, 6)); }
  // Quote all seven slices, or the cash-out prepare, before the action can be signed.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => {
    if (!open || screen !== "amount" || activeIntent || !wallet.authenticated || !wallet.solanaAddress || !network || !canPrepare) return;
    let raw: string;
    try {
      raw = mode === "deposit" ? usdcRaw(amount) : decimalToRaw(amount, withdrawalDecimals(readiness, position), "share");
      if (mode === "deposit" && (BigInt(raw) < BigInt(PUBLIC_DEPOSIT_MINIMUM_USDC_RAW) || insufficientUsdc)) throw new Error("amount");
      if (mode === "withdraw" && (!position?.sharesRaw || BigInt(raw) > BigInt(position.sharesRaw))) throw new Error("shares");
    } catch {
      setQuoteStatus("idle");
      setPrepared(null);
      return;
    }
    const generation = ++quoteGeneration.current;
    const owner = wallet.solanaAddress;
    const preparedNetwork = network;
    const requestKey = prepareRequestKey({ owner, network: preparedNetwork, mode, amountRaw: raw });
    setQuoteStatus("checking");
    setError(null);
    const timer = setTimeout(() => {
      const work = mode === "deposit"
        ? prepareDeposit(indexId, { owner, amountRaw: raw, idempotencyKey: crypto.randomUUID() }, preparedNetwork)
        : prepareWithdrawal(indexId, { owner, shareAmountRaw: raw, requestedExitMode: "verified-native-usdc", idempotencyKey: crypto.randomUUID() }, preparedNetwork);
      void withPrepareTimeout(work).then(step => {
        if (quoteGeneration.current !== generation) return;
        if (step.requires === "user-signature" && step.transactions.length) { setPrepared({ step, requestKey }); setQuoteStatus("ready"); return; }
        setPrepared(null);
        setQuoteStatus("blocked");
        setError(mode === "deposit" ? "Mag7 could not be checked. Try that amount again." : "Cash out could not be checked. Try again.");
      }).catch(error => {
        if (quoteGeneration.current !== generation) return;
        setPrepared(null);
        setQuoteStatus("blocked");
        setError(humanPrepareMessage(error, mode));
      });
    }, 400);
    return () => { clearTimeout(timer); quoteGeneration.current += 1; };
  }, [open, screen, amount, mode, wallet.authenticated, wallet.solanaAddress, network, canPrepare, activeIntent, indexId, insufficientUsdc, position, readiness]);
  function currentRequestKey() {
    if (!wallet.solanaAddress || !network) return null;
    try {
      const amountRaw = mode === "deposit" ? usdcRaw(amount) : decimalToRaw(amount, withdrawalDecimals(readiness, position), "share");
      return prepareRequestKey({ owner: wallet.solanaAddress, network, mode, amountRaw });
    } catch { return null; }
  }
  function start() {
    if (!wallet.authenticated || !wallet.solanaAddress) { setConnectOpen(true); return; }
    if (!canPrepare) { setScreen("prepare"); return; }
    const requestKey = currentRequestKey();
    if (quoteStatus !== "ready" || !prepared || prepared.step.requires !== "user-signature" || prepared.requestKey !== requestKey) return;
    setScreen("approval");
  }
  const check = prepareCheckControl(mode, quoteStatus, Boolean(wallet.authenticated));
  async function approve() {
    if (!prepared || !wallet.solanaAddress) return;
    if (prepared.requestKey !== currentRequestKey()) {
      setPrepared(null);
      setQuoteStatus("idle");
      setError("The amount or wallet changed. Check this action again.");
      setScreen("amount");
      return;
    }
    setBusy(true); setError(null);
    try {
      setSharesBeforeSignature(position?.sharesRaw ?? "0");
      sawWithdrawRef.current = false;
      setSawWithdrawPending(false);
      for (const transaction of prepared.step.transactions) {
        const signature = await wallet.signAndSendTransaction(transaction.messageBase64, prepared.step.network);
        await confirmSignature(signature, prepared.step.network);
      }
      setPrepared(null); setSettlementPosition(null); setTimedOut(false); setScreen("submitted");
    } catch (nextError) { setError(humanPrepareMessage(nextError, mode)); } finally { setBusy(false); }
  }
  if (!open) return null;
  const title = mode === "deposit" ? `Invest in ${indexName}` : `Cash out ${indexName}`;
  const observedShares = positionSharesText(settlementPosition);
  const activeIntentCopy = activeIntent?.kind === "withdraw" ? "A cash-out auction is in progress for this wallet." : "A deposit auction is in progress for this wallet.";
  return <><div className={styles.backdrop} onMouseDown={event => { if (event.currentTarget === event.target) onClose(); }}><aside className={styles.sheet} role="dialog" aria-modal="true" aria-label={title}>
    <header className={styles.top}><div><small>{mode === "deposit" ? "INVEST" : "CASH OUT"}</small><h2>{indexName}</h2></div><button onClick={onClose} aria-label="Close"><Icon name="close" size={20} /></button></header>
    <div className={styles.body}>
      {mode === "deposit" ? <div className={styles.notice}><Icon name="shield" size={18} /><p><strong>Alpha software — experimental; you can lose funds.</strong>Review every wallet approval before signing.</p></div> : null}
      {displayed === "amount" ? <><div className={styles.intro}><h3>{mode === "deposit" ? "Invest in USDC." : "Cash out."}</h3><p>{mode === "deposit" ? "Choose USDC to start a Mag7 auction. Small amounts may buy only some names or none." : CASH_OUT_BEFORE_SIGN}</p></div>
        {mode === "deposit" ? <div className={styles.amountWrap}><label>Amount</label><div className={styles.amount}><span>$</span><input value={amount} inputMode="decimal" onChange={event => changeAmount(event.target.value.replace(/[^0-9.]/g, ""))} /></div><div className={styles.quick}>{DEPOSIT_PRESETS.map(value => <button key={value} onClick={() => changeAmount(String(value))}>${value}</button>)}</div><p className={styles.minimum}>{publicDepositMinimumMessage()}</p></div> : <div className={styles.amountWrap}><label>Shares</label><div className={styles.amount}><input value={amount} inputMode="decimal" onChange={event => changeAmount(event.target.value.replace(/[^0-9.]/g, ""))} /><span>shares</span></div></div>}
        <div className={styles.summary}><div className={styles.row}><span>{mode === "deposit" ? "You invest" : "You cash out"}</span><strong>{mode === "deposit" ? `${amount || "0"} USDC` : `${amount} shares`}</strong></div>{mode === "deposit" && wallet.solanaAddress ? <div className={styles.row}><span>Investing as</span><strong>{wallet.solanaAddress.slice(0, 8)}…{wallet.solanaAddress.slice(-8)}</strong></div> : null}{mode === "deposit" ? <div className={styles.row}><span>USDC in this wallet</span><strong>{wallet.solanaAddress ? <>{availableUsdcText()} USDC <button type="button" className={styles.max} disabled={availableUsdcRaw === null} onClick={useMaxUsdc}>Max</button></> : "Connect wallet to read"}</strong></div> : null}{mode === "deposit" && currentShares ? <div className={styles.row}><span>Your position</span><strong>{currentShares} shares</strong></div> : null}{mode === "withdraw" ? <div className={styles.row}><span>Wallet approvals</span><strong>1 approval now</strong></div> : null}</div>
        {quoteStatus === "checking" ? <p role="status">{mode === "deposit" ? MAG7_FILL_CHECK : CASH_OUT_CHECK}</p> : null}{wallet.authenticated && !canPrepare ? <p role="status">This action is not available right now.</p> : null}{activeIntent ? <div className={styles.blockers}>{activeIntentCopy}</div> : null}{error ? <div className={styles.blockers} role="alert">{error}</div> : null}<div className={styles.notice}><Icon name="shield" size={18} /><p><strong>Nothing moves until you approve.</strong>Connecting a wallet does not invest or cash out.</p></div><div className={styles.cta}><button className={styles.primary} disabled={!check.enabled || busy || insufficientUsdc || Boolean(activeIntent)} onClick={start}>{busy ? "Waiting for wallet…" : check.label}</button></div></>
        : displayed === "prepare" ? <><div className={styles.intro}><h3>Not ready to sign yet.</h3><p>Nothing was sent. Cash out stays unavailable until the share burn can be prepared.</p></div>{error ? <div className={styles.blockers}>{error}</div> : <div className={styles.blockers}>{activeIntentCopy || "This action is not available right now."}</div>}<div className={styles.cta}><button className={styles.secondary} onClick={() => setScreen("amount")}>Back</button></div></>
        : displayed === "approval" ? <><div className={styles.intro}><h3>Approve in your wallet.</h3><p>{mode === "withdraw" ? `Check the amount before you sign. ${CASH_OUT_BEFORE_SIGN}` : "Check the amount before you sign."}</p></div>{error ? <div className={styles.blockers}>{error}</div> : null}<div className={styles.cta}><button className={styles.secondary} onClick={() => setScreen("amount")}>Back</button><button className={styles.primary} disabled={busy || !prepared?.step.transactions.length} onClick={() => void approve()}>{busy ? "Waiting for wallet…" : "Approve in wallet"}</button></div></>
        : <>{view.cashOutFinished ? <div className={styles.phaseCard} role="status" aria-live="polite" data-settlement-status="cash-out-finished"><small>CASH OUT</small><h3>Your shares updated.</h3><p>{settlementDetail(view, settlementPosition, mode)}{observedShares ? ` ${observedShares} shares remain.` : ""}</p></div> : <SettlementListen status={view.status} listening={view.listening} detail={settlementDetail(view, settlementPosition, mode)} />}{mode === "withdraw" ? <CashOutDeliveryStatus assets={cashOutDeliveryOf(observedPosition)} finished={view.cashOutFinished} pendingNote={CASH_OUT_STILL_NOTE} /> : null}{error ? <div className={styles.blockers}>{error}</div> : null}<div className={styles.cta}><button className={styles.primary} onClick={onClose}>Close</button></div></>}
    </div><footer className={styles.footer}>Target mix and share balances are separate from a completed auction. Fees and share amounts are shown only when preparation supplies them.</footer>
  </aside></div><WalletConnectSheet open={connectOpen} onClose={() => setConnectOpen(false)} /></>;
}
