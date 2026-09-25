"use client";

import { useEffect, useState } from "react";
import { usePrivySolana } from "./providers/privy-provider";
import { Icon } from "./social/icon";
import { humanPrepareMessage } from "@/lib/frontend/position-basket";
import { cashOutRequestView, CLAIM_IN_KIND_ACTION, CLAIM_IN_KIND_CHECK } from "@/lib/frontend/cash-out-claim";
import { confirmSignature } from "@/lib/frontend/confirm-signature";
import { announcePositionChange, readSharesBeforeSignature } from "@/lib/frontend/position-refresh";
import { getIndexPosition, getVaultReadiness, prepareClaim, type IndexSharePosition } from "@/lib/frontend/vault-api";
import styles from "./cash-out-claim.module.css";

/** A reserved cash-out request stays visible with an explicit next step: converting to USDC, or a
 * claim-in-kind action once the request timeout passes. Never an endless "pending" spinner. */
export function CashOutClaimPanel({ indexId, position, onPosition }: {
  indexId: string;
  position: IndexSharePosition;
  onPosition?: (position: IndexSharePosition) => void;
}) {
  const wallet = usePrivySolana();
  const request = cashOutRequestView(position);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The request id we already submitted a claim for; a later read of a different (or closed) request clears it.
  const [submitted, setSubmitted] = useState<string | null>(null);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- a polled position read is external state
    if (submitted && submitted !== request?.requestId) setSubmitted(null);
  }, [submitted, request]);

  if (!request) return null;
  const openRequest = request;

  async function claim() {
    if (!wallet.solanaAddress || busy) return;
    setBusy(true);
    setError(null);
    try {
      const owner = wallet.solanaAddress;
      const readiness = await getVaultReadiness(indexId);
      const network = readiness?.identity?.network ?? readiness?.vault?.network;
      if (!network) throw new Error("The vault network could not be read. Try again.");
      const step = await prepareClaim(indexId, { owner, request: openRequest.requestId }, network);
      if (step.requires !== "user-signature" || !step.transactions.length) throw new Error(CLAIM_IN_KIND_CHECK);
      const sharesBeforeRaw = await readSharesBeforeSignature(() => getIndexPosition(indexId, owner), position);
      let lastSignature: string | undefined;
      for (const transaction of step.transactions) {
        const signature = await wallet.signAndSendTransaction(transaction.messageBase64, step.network);
        await confirmSignature(signature, step.network);
        lastSignature = signature;
      }
      announcePositionChange({ indexId, owner, mode: "withdraw", sharesBeforeRaw, signature: lastSignature, at: Date.now() });
      setSubmitted(openRequest.requestId);
      // Re-read at once so the observed delivery/balance replaces this panel as soon as it lands.
      const next = await getIndexPosition(indexId, owner).catch(() => null);
      if (next) onPosition?.(next);
    } catch (nextError) {
      setError(humanPrepareMessage(nextError, "withdraw"));
    } finally {
      setBusy(false);
    }
  }

  return <section className={styles.panel} aria-label="Claim your cash out" data-claim-request={request.requestId} data-claim-phase={request.phase}>
    <header><h2>{request.claimable ? "Claim your share" : "Your cash out is converting"}</h2></header>
    <p>{request.nextAction}</p>
    <p className={styles.fine}>Claiming delivers your reserved stocks and USDC in kind to this wallet. It is not a USDC-only exit, and it needs its own wallet approval.</p>
    {submitted === request.requestId ? <p role="status" className={styles.done}><Icon name="check" size={14} /> Claim submitted. Reading your position…</p> : null}
    {error ? <p role="alert" className={styles.error}>{error}</p> : null}
    {request.claimable && submitted !== request.requestId ? <button type="button" className={styles.action} disabled={busy} onClick={() => void claim()}>{busy ? CLAIM_IN_KIND_CHECK : CLAIM_IN_KIND_ACTION}</button> : null}
    {!request.claimable ? <p className={styles.fine}>This unlocks automatically after the vault&apos;s request timeout. The keeper keeps trying to pay USDC until then.</p> : null}
  </section>;
}
