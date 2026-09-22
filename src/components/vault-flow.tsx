"use client";

import { useEffect, useState } from "react";
import { usePrivySolana } from "./providers/privy-provider";
import { WalletConnectSheet } from "./wallet-connect-sheet";
import { Icon } from "./social/icon";
import { errorText } from "@/lib/frontend/api";
import { PUBLIC_DEPOSIT_MINIMUM_USDC_RAW, publicDepositMinimumMessage } from "@/lib/index-vaults/deposit-floor";
import {
  depositIsEnabled, getIndexPosition, hasIndexShares, prepareDeposit, prepareWithdrawal,
  type IndexSharePosition, type PreparedStep, type VaultReadiness,
} from "@/lib/frontend/vault-api";
import styles from "./vault-flow.module.css";

type Mode = "deposit" | "withdraw";
type Screen = "amount" | "prepare" | "approval" | "submitted";
type Settlement = "pending" | "failed";
const DEPOSIT_PRESETS = [1, 5, 10, 25, 50] as const;
const SETTLEMENT_POLL_TIMEOUT_MS = 5 * 60_000;

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
/** A wallet's prior dust is not a receipt for this signature. */
export function sharesIncreasedAfterSignature(beforeRaw: string, position?: Pick<IndexSharePosition, "sharesRaw"> | null): boolean {
  try { return /^(0|[1-9]\d*)$/.test(beforeRaw) && Boolean(position && /^(0|[1-9]\d*)$/.test(position.sharesRaw) && BigInt(position.sharesRaw) > BigInt(beforeRaw)); }
  catch { return false; }
}
function pendingIntent(position?: IndexSharePosition | null) { return position?.pendingOperations?.find(operation => !operation.complete) ?? null; }
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

export function VaultFlow({ open, onClose, indexId, indexName, readiness, mode = "deposit", position }: { open: boolean; onClose: () => void; indexId: string; indexName: string; readiness?: VaultReadiness | null; mode?: Mode; position?: IndexSharePosition | null; indexKind?: "person" | "theme" }) {
  const wallet = usePrivySolana();
  const [screen, setScreen] = useState<Screen>("amount");
  const [amount, setAmount] = useState(() => mode === "deposit" ? "1" : positionSharesText(position) ?? "0");
  const [prepared, setPrepared] = useState<PreparedStep | null>(null);
  const [settlementPosition, setSettlementPosition] = useState<IndexSharePosition | null>(null);
  const [sharesBeforeSignature, setSharesBeforeSignature] = useState(position?.sharesRaw ?? "0");
  const [settlement, setSettlement] = useState<Settlement>("pending");
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [availableUsdcRaw, setAvailableUsdcRaw] = useState<string | null>(null);
  const [connectOpen, setConnectOpen] = useState(false);
  const activeIntent = pendingIntent(position);
  const currentShares = positionSharesText(position);
  const network = readiness?.identity?.network ?? readiness?.vault?.network;
  const hasVault = Boolean(readiness?.identity || readiness?.vault);
  const canPrepare = hasVault && (mode === "deposit" ? depositIsEnabled(readiness) : readiness?.redeemEnabled === true) && !activeIntent;
  let requestedUsdcRaw: string | null = null;
  try { requestedUsdcRaw = mode === "deposit" ? usdcRaw(amount) : null; } catch { /* start surfaces exact validation copy */ }
  const insufficientUsdc = mode === "deposit" && requestedUsdcRaw !== null && availableUsdcRaw !== null && BigInt(requestedUsdcRaw) > BigInt(availableUsdcRaw);

  // eslint-disable-next-line react-hooks/set-state-in-effect, react-hooks/exhaustive-deps
  useEffect(() => { if (open) { setScreen("amount"); setPrepared(null); setSettlementPosition(null); setSharesBeforeSignature(position?.sharesRaw ?? "0"); setSettlement("pending"); setError(null); setAvailableUsdcRaw(null); setAmount(mode === "deposit" ? "1" : positionSharesText(position) ?? "0"); } }, [open, mode, indexId, position?.sharesRaw, position?.sharesText, position?.shareDecimals]);
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
  useEffect(() => {
    if (!open || screen !== "submitted" || mode !== "deposit" || !wallet.solanaAddress || settlement === "failed") return;
    let alive = true, timer: ReturnType<typeof setTimeout> | null = null;
    const deadline = Date.now() + SETTLEMENT_POLL_TIMEOUT_MS;
    const observe = () => void getIndexPosition(indexId, wallet.solanaAddress!).then(value => {
      if (!alive) return;
      setSettlementPosition(value);
      if (pendingIntent(value)?.phase === "FAILED" || Date.now() >= deadline) { setSettlement("failed"); return; }
      if (!sharesIncreasedAfterSignature(sharesBeforeSignature, value)) timer = setTimeout(observe, 15_000);
    }).catch(() => { if (alive && Date.now() < deadline) timer = setTimeout(observe, 15_000); else if (alive) setSettlement("failed"); });
    observe(); return () => { alive = false; if (timer) clearTimeout(timer); };
  }, [open, screen, mode, indexId, wallet.solanaAddress, sharesBeforeSignature, settlement]);

  function availableUsdcText() { return availableUsdcRaw === null ? "—" : rawToDecimal(availableUsdcRaw, 6); }
  function useMaxUsdc() { if (availableUsdcRaw !== null) setAmount(rawToDecimal(availableUsdcRaw, 6)); }
  function start() {
    try {
      if (activeIntent) throw new Error(activeIntent.kind === "withdraw" ? "Cash out pending settlement." : "Deposit pending settlement.");
      if (mode === "deposit") { const raw = usdcRaw(amount); if (BigInt(raw) < BigInt(PUBLIC_DEPOSIT_MINIMUM_USDC_RAW)) throw new Error(publicDepositMinimumMessage()); if (insufficientUsdc) throw new Error("You don’t have enough USDC for this amount."); }
      else { const raw = decimalToRaw(amount, withdrawalDecimals(readiness, position), "share"); if (!position?.sharesRaw || BigInt(raw) > BigInt(position.sharesRaw)) throw new Error("You cannot redeem more shares than this wallet holds."); }
      setError(null); void doPrepare();
    } catch (nextError) { setError(errorText(nextError)); }
  }
  async function doPrepare() {
    if (!canPrepare) { setScreen("prepare"); return; }
    if (!wallet.authenticated || !wallet.solanaAddress) { setConnectOpen(true); return; }
    if (!network) { setError("The vault network is unavailable."); setScreen("prepare"); return; }
    const preparedNetwork = network;
    setBusy(true); setError(null);
    try {
      const step = mode === "deposit"
        ? await prepareDeposit(indexId, { owner: wallet.solanaAddress, amountRaw: usdcRaw(amount), idempotencyKey: crypto.randomUUID() }, preparedNetwork)
        : await prepareWithdrawal(indexId, { owner: wallet.solanaAddress, shareAmountRaw: decimalToRaw(amount, withdrawalDecimals(readiness, position), "share"), requestedExitMode: "verified-native-usdc", idempotencyKey: crypto.randomUUID() }, preparedNetwork);
      setPrepared(step); setScreen(step.requires === "user-signature" ? "approval" : "prepare");
    } catch (nextError) { setError(errorText(nextError)); setScreen("prepare"); } finally { setBusy(false); }
  }
  async function approve() {
    if (!prepared || !wallet.solanaAddress) return;
    setBusy(true); setError(null);
    try {
      if (mode === "deposit") setSharesBeforeSignature(position?.sharesRaw ?? "0");
      for (const transaction of prepared.transactions) {
        const signature = await wallet.signAndSendTransaction(transaction.messageBase64, prepared.network);
        await confirmSignature(signature, prepared.network);
      }
      setPrepared(null); setSettlementPosition(null); setSettlement("pending"); setScreen("submitted");
    } catch (nextError) { setError(errorText(nextError)); } finally { setBusy(false); }
  }
  if (!open) return null;
  const title = mode === "deposit" ? `Invest in ${indexName}` : `Cash out ${indexName}`;
  const received = sharesIncreasedAfterSignature(sharesBeforeSignature, settlementPosition);
  const activeIntentCopy = activeIntent?.kind === "withdraw" ? "A cash-out auction is in progress for this wallet." : "A deposit auction is in progress for this wallet.";
  return <><div className={styles.backdrop} onMouseDown={event => { if (event.currentTarget === event.target) onClose(); }}><aside className={styles.sheet} role="dialog" aria-modal="true" aria-label={title}>
    <header className={styles.top}><div><small>{mode === "deposit" ? "INVEST" : "CASH OUT"}</small><h2>{indexName}</h2></div><button onClick={onClose} aria-label="Close"><Icon name="close" size={20} /></button></header>
    <div className={styles.body}>
      {mode === "deposit" ? <div className={styles.notice}><Icon name="shield" size={18} /><p><strong>Alpha software — experimental; you can lose funds.</strong>Review every wallet approval before signing.</p></div> : null}
      {screen === "amount" ? <><div className={styles.intro}><h3>{mode === "deposit" ? "Invest in USDC." : "Cash out."}</h3><p>{mode === "deposit" ? "Choose USDC to start a Mag7 auction. Small amounts may buy only some names or none." : "Choose shares to request a USDC auction. Cash out is available only while a sale can be prepared."}</p></div>
        {mode === "deposit" ? <div className={styles.amountWrap}><label>Amount</label><div className={styles.amount}><span>$</span><input value={amount} inputMode="decimal" onChange={event => setAmount(event.target.value.replace(/[^0-9.]/g, ""))} /></div><div className={styles.quick}>{DEPOSIT_PRESETS.map(value => <button key={value} onClick={() => setAmount(String(value))}>${value}</button>)}</div><p className={styles.minimum}>{publicDepositMinimumMessage()}</p></div> : <div className={styles.amountWrap}><label>Shares</label><div className={styles.amount}><input value={amount} inputMode="decimal" onChange={event => setAmount(event.target.value.replace(/[^0-9.]/g, ""))} /><span>shares</span></div></div>}
        <div className={styles.summary}><div className={styles.row}><span>{mode === "deposit" ? "You invest" : "You cash out"}</span><strong>{mode === "deposit" ? `${amount || "0"} USDC` : `${amount} shares`}</strong></div>{mode === "deposit" && wallet.solanaAddress ? <div className={styles.row}><span>Investing as</span><strong>{wallet.solanaAddress.slice(0, 8)}…{wallet.solanaAddress.slice(-8)}</strong></div> : null}{mode === "deposit" ? <div className={styles.row}><span>USDC in this wallet</span><strong>{wallet.solanaAddress ? <>{availableUsdcText()} USDC <button type="button" className={styles.max} disabled={availableUsdcRaw === null} onClick={useMaxUsdc}>Max</button></> : "Connect wallet to read"}</strong></div> : null}{mode === "deposit" && currentShares ? <div className={styles.row}><span>Your position</span><strong>{currentShares} shares</strong></div> : null}{mode === "withdraw" ? <div className={styles.row}><span>Wallet approvals</span><strong>1 approval now</strong></div> : null}</div>
        {activeIntent ? <div className={styles.blockers}>{activeIntentCopy}</div> : null}{error ? <div className={styles.blockers}>{error}</div> : null}<div className={styles.notice}><Icon name="shield" size={18} /><p><strong>Nothing moves until you approve.</strong>Connecting a wallet does not invest or cash out.</p></div><div className={styles.cta}><button className={styles.primary} disabled={busy || insufficientUsdc || Boolean(activeIntent)} onClick={start}>{!wallet.authenticated ? "Connect to continue" : busy ? "Preparing…" : mode === "deposit" ? "Invest" : "Cash out"}</button></div></>
        : screen === "prepare" ? <><div className={styles.intro}><h3>Not ready to sign yet.</h3><p>Nothing was sent. Cash out stays unavailable until its USDC auction can be prepared.</p></div>{error ? <div className={styles.blockers}>{error}</div> : <div className={styles.blockers}>{activeIntentCopy || "This action is not available right now."}</div>}<div className={styles.cta}><button className={styles.secondary} onClick={() => setScreen("amount")}>Back</button></div></>
        : screen === "approval" ? <><div className={styles.intro}><h3>Approve in your wallet.</h3><p>Check the amount before you sign.</p></div>{error ? <div className={styles.blockers}>{error}</div> : null}<div className={styles.cta}><button className={styles.secondary} onClick={() => setScreen("amount")}>Back</button><button className={styles.primary} disabled={busy || !prepared?.transactions.length} onClick={() => void approve()}>{busy ? "Waiting for wallet…" : "Approve in wallet"}</button></div></>
        : <><div className={styles.phaseCard}><small>{mode === "deposit" ? "INVEST" : "CASH OUT"}</small><h3>{mode === "deposit" ? received ? "Shares received." : settlement === "failed" ? "Failed" : "Deposit pending settlement" : "Cash-out auction started"}</h3><p>{mode === "deposit" ? received ? "Your share balance increased after this signature." : settlement === "failed" ? "This deposit did not buy the basket. Your USDC is still in Mag7 and is not shares." : "Your deposit is waiting for the Mag7 auction. This status will stop waiting if the auction fails or times out." : "The sale was prepared and signed. USDC is not promised until the vault auction settles."}</p></div>{error ? <div className={styles.blockers}>{error}</div> : null}<div className={styles.cta}><button className={styles.primary} onClick={onClose}>{mode === "deposit" ? "Close and check later" : "Done"}</button></div></>}
    </div><footer className={styles.footer}>Target mix and share balances are separate from a completed auction. Fees and share amounts are shown only when preparation supplies them.</footer>
  </aside></div><WalletConnectSheet open={connectOpen} onClose={() => setConnectOpen(false)} /></>;
}
