"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { getOperation, prepareNext, submitReceipts, type ObservedOperation, type PreparedStep } from "@/lib/frontend/vault-api";
import { usePrivySolana } from "./providers/privy-provider";
import { WalletButton } from "./wallet-button";
import { Icon } from "./social/icon";
import { errorText } from "@/lib/frontend/api";
import styles from "./operation-status.module.css";

function label(value: string) {
  return value.toLowerCase().replaceAll("_", " ").replace(/^./, (character) => character.toUpperCase());
}

export function OperationStatus({ operationId }: { operationId: string }) {
  const wallet = usePrivySolana();
  const [operation, setOperation] = useState<ObservedOperation | null>(null);
  const [prepared, setPrepared] = useState<PreparedStep | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    setBusy(true);
    setError(null);
    try {
      setOperation(await getOperation(operationId));
      setPrepared(null);
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => { void load(); }, [operationId]);

  async function next() {
    if (!wallet.solanaAddress || !operation) return;
    setBusy(true);
    setError(null);
    try {
      const network = operation.identity?.network;
      if (!network) throw new Error("The operation network is unavailable.");
      const step = await prepareNext(operation.operationId, wallet.solanaAddress, network);
      if (step.requires === "user-signature") setPrepared(step);
      else await load();
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(false);
    }
  }

  async function approve() {
    if (!wallet.solanaAddress || !prepared) return;
    setBusy(true);
    setError(null);
    try {
      let observed: ObservedOperation | null = null;
      for (const transaction of prepared.transactions) {
        const signature = await wallet.signAndSendTransaction(transaction.messageBase64, prepared.network);
        observed = await submitReceipts(prepared.operationId, wallet.solanaAddress, [{ stepId: transaction.stepId, signature }]);
        setOperation(observed);
        setPrepared((current) => current ? { ...current, transactions: current.transactions.filter((candidate) => candidate.stepId !== transaction.stepId) } : current);
      }
      if (observed) setPrepared(null);
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(false);
    }
  }

  return <div className={styles.page}>
    <Link href="/positions" className={styles.back}><Icon name="arrow" size={13} style={{ transform: "rotate(180deg)" }} />Your portfolio</Link>
    <header><span>RESUMABLE OPERATION</span><h1>{operation ? label(operation.phase) : "Loading operation…"}</h1><p>Closing InsiderIndex does not erase native vault state. This page reconciles confirmed receipts and tells you the next safe action.</p></header>
    {error ? <div className={styles.error}>{error}</div> : null}
    {operation ? <div className={styles.grid}>
      <section><small>OPERATION</small><code>{operation.operationId}</code><div><span>Kind</span><b>{operation.kind}</b></div><div><span>Current phase</span><b>{label(operation.phase)}</b></div><div><span>Complete</span><b>{operation.complete ? "Yes" : "No"}</b></div><div><span>Next action</span><b>{operation.nextAction ?? "Reconcile state"}</b></div></section>
      <section><small>CHAIN OBLIGATIONS</small><div><span>Outstanding claims</span><b>{operation.outstandingClaims?.length ?? 0}</b></div><div><span>Confirmed credits</span><b>{operation.credits?.length ?? 0}</b></div><div><span>Blockers</span><b>{operation.blockers?.length ?? 0}</b></div>{operation.blockers?.map((blocker, index) => <p key={index}>{blocker}</p>)}</section>
    </div> : null}
    {prepared ? <section className={styles.approval}><small>WALLET APPROVAL REQUIRED</small><h2>{prepared.transactions.length} prepared {prepared.transactions.length === 1 ? "transaction" : "transactions"}</h2><p>Review the wallet prompt for each prepared step. Nothing is submitted until you approve it.</p>{prepared.transactions.map((transaction) => <div key={transaction.stepId}><span>{label(transaction.stepId)}</span><b>{transaction.maxDebits.length ? `${transaction.maxDebits.map((debit) => debit.amountRaw).join(", ")} raw maximum` : "No token debit declared"}</b></div>)}</section> : null}
    <div className={styles.actions}>{!wallet.authenticated ? <WalletButton /> : prepared ? <button disabled={busy} onClick={() => void approve()}>{busy ? "Waiting for wallet…" : "Approve in wallet"}</button> : <button disabled={busy || !operation} onClick={() => void next()}>{busy ? "Checking…" : "Continue safely"}</button>}<button disabled={busy} onClick={() => void load()}>Refresh</button></div>
  </div>;
}
