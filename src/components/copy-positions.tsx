"use client";
import Link from "next/link";
import { useResource } from "@/lib/frontend/use-resource";
import { formatReceiptAmount, type TrackedPosition } from "@/lib/position-contract";
import { PageError, Skeleton } from "./social/shared";
import styles from "./disclosure-workspace.module.css";

type CopyReceipts = { positions: TrackedPosition[] };
export function CopyPositions({ address, initialData }: { address: string; initialData?: CopyReceipts }) {
  const resource = useResource<CopyReceipts>(`/api/positions/copies?wallet=${encodeURIComponent(address)}`, initialData);
  return <section className={styles.section} aria-labelledby="copy-receipts-title">
    <div className={styles.sectionHead}><h2 id="copy-receipts-title">Copy trade receipts</h2><button className={styles.refreshButton} onClick={resource.reload} disabled={resource.loading}>Refresh receipts</button></div>
    <p>Most recent 100 fills for this wallet. Receipts are not current token balances, portfolio value, profit-and-loss or index shares. Exit is not available here yet.</p>
    {resource.error ? <PageError error={resource.error} retry={resource.reload} /> : resource.loading ? <Skeleton cards={2} /> : resource.data ? <CopyReceiptRows address={address} positions={resource.data.positions} /> : null}
    <Link className={styles.primaryButton} href="/feed">Copy one print</Link>
  </section>;
}

export function CopyReceiptRows({ address, positions }: { address: string; positions: TrackedPosition[] }) {
  if (positions.some(p => p.wallet !== address)) return <p role="alert">Receipt wallet mismatch. No receipts are shown.</p>;
  if (!positions.length) return <p>No saved copy receipts for this wallet. This does not mean your wallet is empty.</p>;
  return <div className={styles.tableWrap} role="region" aria-label="Copy trade receipts" tabIndex={0}><table className={styles.table}>
    <thead><tr><th>Trade</th><th>Paid</th><th>Received</th><th>Transaction</th></tr></thead>
    <tbody>{positions.map(p => <tr key={p.id}><td>{p.side === "buy" ? "Buy" : "Sell"} {p.tokenSymbol}{p.stub ? " · Development fixture" : ""}<small>{p.createdAt}</small></td>
      <td>{formatReceiptAmount(p.inputAmountRaw, p.inputDecimals)} {p.side === "buy" ? "USDC" : p.tokenSymbol}</td>
      <td>{formatReceiptAmount(p.outputAmountRaw, p.outputDecimals)} {p.side === "buy" ? p.tokenSymbol : "USDC"}</td>
      <td>{p.stub ? "Not on-chain" : <a href={`https://explorer.solana.com/tx/${encodeURIComponent(p.signature)}`} target="_blank" rel="noreferrer">View confirmed fill</a>}</td></tr>)}</tbody>
  </table></div>;
}
