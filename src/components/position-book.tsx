"use client";

import { StockIcon } from "./social/shared";
import { formatObservedAmount, type CashOutAsset } from "@/lib/frontend/position-basket";
import { markedDollars } from "@/lib/frontend/research-format";
import { tokenAmountText, weightText, type NavHeldBook } from "@/lib/nav-vault/held";
import styles from "./position-detail.module.css";

export function PositionBook({ title, note, filled, missing, state = "held" }: {
  title: string;
  note: string;
  filled: { ticker: string; mint: string }[];
  missing: { ticker: string; mint: string }[];
  state?: "held" | "bought";
}) {
  const filledLabel = state === "bought" ? "Bought" : "Held";
  const missingLabel = state === "bought" ? "Not bought yet" : "Not held";
  return <section className={styles.panel} aria-label={title}>
    <header><h2>{title}</h2><p>{note}</p></header>
    {filled.length ? <div className={styles.weights}>{filled.map((leg, index) => <div key={leg.mint}>
      <span>{String(index + 1).padStart(2, "0")}</span>
      <StockIcon ticker={leg.ticker} size="sm" />
      <strong>{leg.ticker}</strong>
      <i><b style={{ width: "100%" }} /></i>
      <em>{filledLabel}</em>
    </div>)}</div> : <div className={styles.empty}>{state === "bought" ? "None of the target names have been bought yet." : "None of the target names are held."}</div>}
    {missing.length ? <div className={styles.missing}><h3>{missingLabel}</h3><ul>{missing.map(leg => <li key={leg.mint}><StockIcon ticker={leg.ticker} size="sm" /><strong>{leg.ticker}</strong><span>{missingLabel}</span></li>)}</ul></div> : null}
  </section>;
}

/** NAV vault: this wallet's pro-rata slice of the vault's on-chain balances, valued at keeper marks. */
export function HeldNowBook({ held }: { held: NavHeldBook }) {
  const note = `Your share of what the vault holds on chain, valued at the keeper's latest marks.${held.pricesFresh ? "" : " Marks are not fresh, so values may lag."}`;
  return <section className={styles.panel} aria-label="Held now">
    <header><h2>Held now</h2><p>{note}</p></header>
    <ul className={styles.held}>
      {held.legs.map(leg => {
        const amount = tokenAmountText(leg.amountRaw, leg.decimals);
        return <li key={leg.mint}>
          <StockIcon ticker={leg.ticker} size="sm" />
          <div className={styles.heldName}><strong>{leg.ticker}</strong><small>{leg.amountRaw === "0" ? "Not held yet" : `${amount} ${leg.ticker}`}</small></div>
          <i aria-hidden="true"><b style={{ width: `${Math.min(leg.weightBps, 10_000) / 100}%` }} /></i>
          <div className={styles.heldValue}><strong>{markedDollars(leg.valueUsdc)}</strong><small>{weightText(leg.weightBps)}</small></div>
        </li>;
      })}
      <li>
        <span className={styles.cashIcon} aria-hidden="true">$</span>
        <div className={styles.heldName}><strong>USDC</strong><small>{tokenAmountText(held.usdc.amountRaw, 6)} USDC · cash buffer</small></div>
        <i aria-hidden="true"><b style={{ width: `${Math.min(held.usdc.weightBps, 10_000) / 100}%` }} /></i>
        <div className={styles.heldValue}><strong>{markedDollars(held.usdc.valueUsdc)}</strong><small>{weightText(held.usdc.weightBps)}</small></div>
      </li>
    </ul>
    <div className={styles.heldTotal}><span>Total</span><strong>{markedDollars(held.totalUsdc)}</strong></div>
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
