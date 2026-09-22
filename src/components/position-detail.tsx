"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePrivySolana } from "./providers/privy-provider";
import { WalletButton } from "./wallet-button";
import { Icon } from "./social/icon";
import { StockIcon } from "./social/shared";
import { AllocationBreakdown } from "./allocation-breakdown";
import { getIndexPosition, getVaultReadiness, positionValueUsdc, type IndexSharePosition, type VaultReadiness } from "@/lib/frontend/vault-api";
import { markedDollars } from "@/lib/frontend/research-format";
import { formatVaultShares } from "@/lib/index-vaults/positions-contract";
import { errorText } from "@/lib/frontend/api";
import styles from "./position-detail.module.css";

export function PositionDetail({ indexId }: { indexId: string }) {
  const wallet = usePrivySolana();
  const [position, setPosition] = useState<IndexSharePosition | null>(null);
  const [readiness, setReadiness] = useState<VaultReadiness | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  const targetMix = useMemo(
    () => [...(readiness?.targetWeights ?? [])].sort((a, b) => b.weightBps - a.weightBps),
    [readiness],
  );
  const name = position?.indexName ?? indexId;
  const sharesText = position ? position.sharesText ?? formatVaultShares(position.sharesRaw, position.shareDecimals ?? 0) : null;
  const valueText = position ? markedDollars(positionValueUsdc(position)) : "—";

  if (!wallet.solanaAddress) return <div className={styles.page}><Link className={styles.back} href="/positions"><Icon name="arrow" size={13} style={{ transform: "rotate(180deg)" }} />Your portfolio</Link><div className={styles.gate}><span>POSITION DETAIL</span><h1>Connect to open<br />this position.</h1><p>Connect your wallet to see your shares.</p><WalletButton /></div></div>;

  return <div className={styles.page}>
    <Link className={styles.back} href="/positions"><Icon name="arrow" size={13} style={{ transform: "rotate(180deg)" }} />Your portfolio</Link>
    {loading ? <div className={styles.loading}>Reading your shares…</div> : error ? <div className={styles.error}>{error}</div> : !position ? <div className={styles.gate}><span>NO POSITION</span><h1>No index shares found.</h1><p>This wallet does not hold index shares yet.</p><Link href={`/indexes/${encodeURIComponent(indexId)}`}>Open index</Link></div> : <>
      <section className={styles.hero}>
        <div className={styles.photo}><span>YOUR INDEX</span></div>
        <div className={styles.identity}>
          <small>INDEX POSITION</small><h1>{name}</h1>
          <div className={styles.numbers}>
            <div><strong>{sharesText}</strong><span>shares</span></div>
            <div><strong>{valueText}</strong><span>USDC value</span></div>
          </div>
          <div className={styles.actions}><Link href={`/indexes/${encodeURIComponent(indexId)}`}>View index</Link></div>
        </div>
      </section>

      <div className={styles.grid}><section className={styles.panel}><header><h2>Target mix</h2><p>Published target allocation</p></header>{targetMix.length ? <><div className={styles.allocationWrap}><AllocationBreakdown title="Target mix" subtitle="Published allocation" items={targetMix.map((weight) => ({ ticker: weight.ticker ?? weight.mint.slice(0, 5), name: weight.ticker ? "Index constituent" : "Vault asset", weight: weight.weightBps / 10_000 }))} /></div><div className={styles.weights}>{targetMix.map((weight, index) => <div key={weight.mint}><span>{String(index + 1).padStart(2, "0")}</span><StockIcon ticker={weight.ticker ?? weight.mint.slice(0, 5)} size="sm" /><strong>{weight.ticker ?? weight.mint.slice(0, 5)}</strong><i><b style={{ width: `${Math.max(3, weight.weightBps / Math.max(1, targetMix[0].weightBps) * 100)}%` }} /></i><em>{(weight.weightBps / 100).toFixed(1)}%</em></div>)}</div></> : <div className={styles.empty}>The target mix is unavailable right now.</div>}</section></div>

      {position.outstandingClaims?.length ? <section className={styles.claims}><h2>Outstanding claims</h2>{position.outstandingClaims.map((claim) => <div key={claim.mint}><strong>{claim.symbol ?? claim.mint.slice(0, 7)}</strong><span>{claim.amountRemainingRaw} units remaining</span><b>{claim.transferBlocked ? "NEEDS ATTENTION" : "PENDING"}</b></div>)}</section> : null}
    </>}
  </div>;
}
