"use client";

import { StockIcon } from "./social/shared";
import { formatObservedAmount, type CashOutAsset } from "@/lib/frontend/position-basket";
import styles from "./position-detail.module.css";

export function PositionBook({ title, note, filled, missing }: {
  title: string;
  note: string;
  filled: { ticker: string; mint: string }[];
  missing: { ticker: string; mint: string }[];
}) {
  return <section className={styles.panel} aria-label={title}>
    <header><h2>{title}</h2><p>{note}</p></header>
    {filled.length ? <div className={styles.weights}>{filled.map((leg, index) => <div key={leg.mint}>
      <span>{String(index + 1).padStart(2, "0")}</span>
      <StockIcon ticker={leg.ticker} size="sm" />
      <strong>{leg.ticker}</strong>
      <i><b style={{ width: "100%" }} /></i>
      <em>Held</em>
    </div>)}</div> : <div className={styles.empty}>None of the target names are held.</div>}
    {missing.length ? <div className={styles.missing}><h3>Not held</h3><ul>{missing.map(leg => <li key={leg.mint}><StockIcon ticker={leg.ticker} size="sm" /><strong>{leg.ticker}</strong><span>Not held</span></li>)}</ul></div> : null}
  </section>;
}

export function CashOutAssetList({ assets, heading, note }: { assets: CashOutAsset[]; heading: string; note: string }) {
  return <section className={styles.claims} aria-label={heading}>
    <h2>{heading}</h2>
    <p>{note}</p>
    {assets.length ? <ul>{assets.map(asset => <li key={asset.mint}>{formatObservedAmount(asset)}</li>)}</ul> : <p>No leftover holdings were listed on the last read.</p>}
  </section>;
}

export function CashOutDeliveryStatus({ assets, finished, pendingNote }: { assets: CashOutAsset[]; finished: boolean; pendingNote: string }) {
  if (finished) return <p role="status">Cash out complete — check your wallet.</p>;
  return <CashOutAssetList assets={assets} heading="Still in this cash-out" note={pendingNote} />;
}
