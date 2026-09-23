"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePrivySolana } from "./providers/privy-provider";
import { WalletButton } from "./wallet-button";
import { Icon } from "./social/icon";
import { getIndexPosition, getVaultReadiness, positionValueUsdc, publicIndexCanCashOut, type IndexSharePosition, type VaultReadiness } from "@/lib/frontend/vault-api";
import { markedDollars } from "@/lib/frontend/research-format";
import { positionHoldingFigures } from "@/lib/frontend/position-share-copy";
import { errorText } from "@/lib/frontend/api";
import { noticedShareArrival, plainStatusForOperation, positionNeedsListen, SETTLEMENT_POLL_MS, settlementDetail } from "@/lib/frontend/settlement-progress";
import { CASH_OUT_BEFORE_SIGN, CASH_OUT_STILL_NOTE } from "@/lib/frontend/position-basket";
import { CashOutAssetList, PositionBook } from "./position-book";
import { VaultFlow } from "./vault-flow";
import { SettlementListen } from "./settlement-listen";
import styles from "./position-detail.module.css";

function pendingKey(position?: IndexSharePosition | null) {
  return JSON.stringify(position?.pendingOperations?.map(operation => ({
    operationId: operation.operationId,
    phase: operation.phase,
    complete: operation.complete === true,
    fill: operation.fill,
    delivery: operation.delivery,
  })) ?? []);
}

export function PositionDetail({ indexId }: { indexId: string }) {
  const wallet = usePrivySolana();
  const [position, setPosition] = useState<IndexSharePosition | null>(null);
  const [readiness, setReadiness] = useState<VaultReadiness | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cashOutOpen, setCashOutOpen] = useState(false);
  const [sharesArrived, setSharesArrived] = useState(false);
  const pendingSignature = pendingKey(position);

  // Synchronize the wallet-scoped view with the external position endpoints.
  useEffect(() => {
    let alive = true;
    if (!wallet.solanaAddress) return;
    // This request lifecycle deliberately clears stale UI before the next wallet-scoped response arrives.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    setError(null);
    Promise.all([getIndexPosition(indexId, wallet.solanaAddress), getVaultReadiness(indexId).catch(() => null)])
      .then(([nextPosition, nextReadiness]) => {
        if (alive) {
          setPosition(nextPosition);
          setReadiness(nextReadiness);
        }
      })
      .catch((nextError) => { if (alive) setError(errorText(nextError)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [indexId, wallet.solanaAddress]);

  useEffect(() => {
    if (!wallet.solanaAddress || cashOutOpen || !positionNeedsListen(position)) return;
    let alive = true;
    const timer = setInterval(() => {
      void getIndexPosition(indexId, wallet.solanaAddress!).then(next => {
        if (!alive || !next) return;
        setSharesArrived(noticedShareArrival(position, next) || (sharesArrived && !positionNeedsListen(next)));
        if (positionNeedsListen(next)) setSharesArrived(false);
        setPosition(current => pendingKey(current) === pendingKey(next) && current?.sharesRaw === next.sharesRaw ? current : next);
      }).catch(() => {});
    }, SETTLEMENT_POLL_MS);
    return () => { alive = false; clearInterval(timer); };
  }, [indexId, wallet.solanaAddress, cashOutOpen, position, sharesArrived, pendingSignature]);

  const activeOperation = position?.pendingOperations?.find(operation => !operation.complete) ?? null;
  const depositFill = activeOperation?.kind === "deposit" ? activeOperation.fill : undefined;
  const delivery = activeOperation?.kind === "withdraw" ? activeOperation.delivery ?? [] : [];
  const book = position?.basket
    ? { title: "Held now", note: `${position.basket.heldCount} of ${position.basket.targetCount} target names are in the vault. Missing names are not held.`, filled: position.basket.legs.filter(leg => leg.held), missing: position.basket.legs.filter(leg => !leg.held), state: "held" as const }
    : depositFill
      ? { title: "Bought so far", note: "This auction has not minted shares. Missing names were not bought.", filled: depositFill.filled, missing: depositFill.missing, state: "bought" as const }
      : null;
  const cashOutNetwork = readiness?.identity?.network ?? readiness?.vault?.network;
  const canCashOut = Boolean(position && cashOutNetwork && BigInt(position.sharesRaw) > 0n && !activeOperation && publicIndexCanCashOut(indexId, {
    vaultAddress: readiness?.identity?.vaultAccount ?? readiness?.vault?.vaultAccount,
    shareMint: readiness?.identity?.shareMint ?? readiness?.vault?.shareMint,
    network: cashOutNetwork,
  }));
  const settlementStatus = activeOperation ? plainStatusForOperation(activeOperation) : sharesArrived ? "shares received" : null;
  const name = position?.indexName ?? indexId;
  const valueText = position ? markedDollars(positionValueUsdc(position) ?? position.markedValueUsdc) : "—";
  const figures = position ? positionHoldingFigures({ sharesRaw: position.sharesRaw, shareDecimals: position.shareDecimals, valueText }) : [];

  if (!wallet.solanaAddress) return <div className={styles.page}><Link className={styles.back} href="/positions"><Icon name="arrow" size={13} style={{ transform: "rotate(180deg)" }} />Your portfolio</Link><div className={styles.gate}><span>POSITION DETAIL</span><h1>Connect to open<br />this position.</h1><p>Connect your wallet to see your shares.</p><WalletButton /></div></div>;

  return <div className={styles.page}>
    <Link className={styles.back} href="/positions"><Icon name="arrow" size={13} style={{ transform: "rotate(180deg)" }} />Your portfolio</Link>
    {loading ? <div className={styles.loading}>Reading your shares…</div> : error ? <div className={styles.error}>{error}</div> : !position ? <div className={styles.gate}><span>NO POSITION</span><h1>No index shares found.</h1><p>This wallet does not hold index shares yet.</p><Link href={`/indexes/${encodeURIComponent(indexId)}`}>Open index</Link></div> : <>
      <section className={styles.hero}>
        <div className={styles.identity}>
          <small>INDEX POSITION</small><h1>{name}</h1>
          <div className={styles.numbers}>
            {figures.map(figure => <div key={figure.role} className={figure.primary ? styles.valueLead : undefined}><strong>{figure.text}</strong><span>{figure.label}</span></div>)}
          </div>
          <div className={styles.actions}><Link href={`/indexes/${encodeURIComponent(indexId)}`}>View index</Link>{activeOperation ? <button type="button" disabled> {activeOperation.kind === "withdraw" ? "Cash out in progress" : "Deposit in progress"}</button> : canCashOut ? <button type="button" onClick={() => setCashOutOpen(true)}>Cash out</button> : null}</div>
          {settlementStatus ? <SettlementListen status={settlementStatus} listening={positionNeedsListen(position)} detail={activeOperation ? settlementDetail({ status: settlementStatus, listening: positionNeedsListen(position), cashOutFinished: false }, position, activeOperation.kind === "withdraw" ? "withdraw" : "deposit") : "Your share balance increased."} /> : null}
          {BigInt(position.sharesRaw) > 0n ? <p className={styles.operation}>{CASH_OUT_BEFORE_SIGN}</p> : null}
        </div>
      </section>

      <div className={styles.grid}>{book ? <PositionBook title={book.title} note={book.note} filled={book.filled} missing={book.missing} state={book.state} /> : <section className={styles.panel}><header><h2>Held now</h2><p>Published target is not what this wallet holds</p></header><div className={styles.empty}>The held book is unavailable. The target mix is not shown as if it were held.</div></section>}</div>
      {delivery.length ? <CashOutAssetList assets={delivery} heading="Still in this cash-out" note={CASH_OUT_STILL_NOTE} /> : null}

      {position.outstandingClaims?.length ? <section className={styles.claims}><h2>Outstanding claims</h2>{position.outstandingClaims.map((claim) => <div key={claim.mint}><strong>{claim.symbol ?? claim.mint.slice(0, 7)}</strong><span>{claim.amountRemainingRaw} units remaining</span><b>{claim.transferBlocked ? "NEEDS ATTENTION" : "PENDING"}</b></div>)}</section> : null}
      <VaultFlow open={cashOutOpen} onClose={() => setCashOutOpen(false)} indexId={indexId} indexName={name} readiness={readiness} mode="withdraw" position={position} onPosition={next => { if (!next) return; setPosition(current => pendingKey(current) === pendingKey(next) && current?.sharesRaw === next.sharesRaw ? current : next); }} />
    </>}
  </div>;
}
