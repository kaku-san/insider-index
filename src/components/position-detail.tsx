"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePrivySolana } from "./providers/privy-provider";
import { WalletButton } from "./wallet-button";
import { Icon } from "./social/icon";
import { StockIcon } from "./social/shared";
import { getIndexPosition, getVaultReadiness, positionValueUsdc, prepareWithdrawal, publicIndexCanCashOut, type IndexSharePosition, type VaultReadiness } from "@/lib/frontend/vault-api";
import { markedDollars } from "@/lib/frontend/research-format";
import { formatVaultShares } from "@/lib/index-vaults/positions-contract";
import { errorText } from "@/lib/frontend/api";
import { VaultFlow } from "./vault-flow";
import styles from "./position-detail.module.css";

export function PositionDetail({ indexId }: { indexId: string }) {
  const wallet = usePrivySolana();
  const [position, setPosition] = useState<IndexSharePosition | null>(null);
  const [readiness, setReadiness] = useState<VaultReadiness | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cashOutReady, setCashOutReady] = useState(false);
  const [cashOutOpen, setCashOutOpen] = useState(false);

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
    let alive = true;
    const network = readiness?.identity?.network ?? readiness?.vault?.network;
    const canTry = Boolean(wallet.solanaAddress && position && BigInt(position.sharesRaw) > 0n && network && publicIndexCanCashOut(indexId, {
      vaultAddress: readiness?.identity?.vaultAccount ?? readiness?.vault?.vaultAccount,
      shareMint: readiness?.identity?.shareMint ?? readiness?.vault?.shareMint,
      network,
    }));
    if (!canTry || !position || !wallet.solanaAddress || !network || position.pendingOperations?.some(operation => !operation.complete)) { setCashOutReady(false); return; }
    setCashOutReady(false);
    void prepareWithdrawal(indexId, { owner: wallet.solanaAddress, shareAmountRaw: position.sharesRaw, requestedExitMode: "verified-native-usdc", idempotencyKey: crypto.randomUUID() }, network)
      .then(() => { if (alive) setCashOutReady(true); }).catch(() => { if (alive) setCashOutReady(false); });
    return () => { alive = false; };
  }, [indexId, wallet.solanaAddress, position?.sharesRaw, position?.pendingOperations, readiness?.identity?.vaultAccount, readiness?.identity?.shareMint, readiness?.identity?.network, readiness?.vault?.vaultAccount, readiness?.vault?.shareMint, readiness?.vault?.network]);

  const targetMix = useMemo(
    () => [...(readiness?.targetWeights ?? [])].sort((a, b) => b.weightBps - a.weightBps),
    [readiness],
  );
  const activeOperation = position?.pendingOperations?.find(operation => !operation.complete) ?? null;
  const name = position?.indexName ?? indexId;
  const sharesText = position ? position.sharesText ?? formatVaultShares(position.sharesRaw, position.shareDecimals ?? 0) : null;
  const valueText = position ? markedDollars(positionValueUsdc(position)) : "—";

  if (!wallet.solanaAddress) return <div className={styles.page}><Link className={styles.back} href="/positions"><Icon name="arrow" size={13} style={{ transform: "rotate(180deg)" }} />Your portfolio</Link><div className={styles.gate}><span>POSITION DETAIL</span><h1>Connect to open<br />this position.</h1><p>Connect your wallet to see your shares.</p><WalletButton /></div></div>;

  return <div className={styles.page}>
    <Link className={styles.back} href="/positions"><Icon name="arrow" size={13} style={{ transform: "rotate(180deg)" }} />Your portfolio</Link>
    {loading ? <div className={styles.loading}>Reading your shares…</div> : error ? <div className={styles.error}>{error}</div> : !position ? <div className={styles.gate}><span>NO POSITION</span><h1>No index shares found.</h1><p>This wallet does not hold index shares yet.</p><Link href={`/indexes/${encodeURIComponent(indexId)}`}>Open index</Link></div> : <>
      <section className={styles.hero}>
        <div className={styles.identity}>
          <small>INDEX POSITION</small><h1>{name}</h1>
          <div className={styles.numbers}>
            <div><strong>{sharesText}</strong><span>shares</span></div>
            <div><strong>{valueText}</strong><span>USDC value</span></div>
          </div>
          <div className={styles.actions}><Link href={`/indexes/${encodeURIComponent(indexId)}`}>View index</Link>{activeOperation ? <button type="button" disabled> {activeOperation.kind === "withdraw" ? "Cash out in progress" : "Deposit in progress"}</button> : cashOutReady ? <button type="button" onClick={() => setCashOutOpen(true)}>Cash out</button> : null}</div>
          {activeOperation ? <p className={styles.operation}>{activeOperation.phase === "FAILED" ? "This deposit did not buy the basket. Your USDC is still in Mag7 and is not shares." : activeOperation.kind === "withdraw" ? "A cash-out auction is in progress for this wallet." : "A deposit auction is in progress for this wallet."}</p> : null}
          {!activeOperation && !cashOutReady ? <p className={styles.operation}>Cash out is unavailable until a USDC sale can be prepared.</p> : null}
        </div>
      </section>

      <div className={styles.grid}><section className={styles.panel}><header><h2>Target mix</h2><p>Published target allocation</p></header>{targetMix.length ? <div className={styles.weights}>{targetMix.map((weight, index) => <div key={weight.mint}><span>{String(index + 1).padStart(2, "0")}</span><StockIcon ticker={weight.ticker ?? weight.mint.slice(0, 5)} size="sm" /><strong>{weight.ticker ?? weight.mint.slice(0, 5)}</strong><i><b style={{ width: `${Math.max(3, weight.weightBps / Math.max(1, targetMix[0].weightBps) * 100)}%` }} /></i><em>{(weight.weightBps / 100).toFixed(1)}%</em></div>)}</div> : <div className={styles.empty}>The target mix is unavailable right now.</div>}</section></div>

      {position.outstandingClaims?.length ? <section className={styles.claims}><h2>Outstanding claims</h2>{position.outstandingClaims.map((claim) => <div key={claim.mint}><strong>{claim.symbol ?? claim.mint.slice(0, 7)}</strong><span>{claim.amountRemainingRaw} units remaining</span><b>{claim.transferBlocked ? "NEEDS ATTENTION" : "PENDING"}</b></div>)}</section> : null}
      <VaultFlow open={cashOutOpen} onClose={() => setCashOutOpen(false)} indexId={indexId} indexName={name} readiness={readiness} mode="withdraw" position={position} />
    </>}
  </div>;
}
