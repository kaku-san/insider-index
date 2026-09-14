"use client";
import { useState } from "react";
import Link from "next/link";
import { usePrivySolana } from "./providers/privy-provider";
import { useResource } from "@/lib/frontend/use-resource";
import type { TrackedPosition } from "@/lib/frontend/contracts";
import { Icon } from "./social/icon";
import { PageError, Skeleton } from "./social/shared";
import { WalletButton } from "./wallet-button";
import { formatDate, formatShares, formatUsd, shortenAddress } from "@/lib/format";
import styles from "./disclosure-workspace.module.css";

export function PositionsTable() {
  const wallet = usePrivySolana();
  return <div className={styles.workspace}>
    <header className={styles.indexHero}><span className={styles.kicker}>Your wallet, on the record</span><h1>My positions</h1><p>Your signed fills. No inferred profits, no pretend balances.</p></header>
    {wallet.solanaAddress ? <WalletPositions key={wallet.solanaAddress} address={wallet.solanaAddress} live={wallet.mode === "live"} /> : <section className={styles.empty}>
      <Icon name="wallet" size={38} /><h2 className={styles.connectTitle}>A book of your own.</h2>
      <p>{wallet.mode === "unavailable" ? "Wallet connection is unavailable. Retry to reload Privy. We won’t substitute a demo wallet." : "Connect your Solana wallet through Privy to see the fills recorded for your address."}</p>
      <WalletButton /><p className={styles.finePrint}>Connecting doesn’t move funds or approve a trade.</p>
    </section>}
    <p className={styles.finePrint}>This is recorded transaction history, not a live wallet balance or profit-and-loss report. Published model indexes cannot accept deposits until a share-token vault is connected.</p>
  </div>;
}

function WalletPositions({ address, live }: { address: string; live: boolean }) {
  const [query, setQuery] = useState("");
  const resource = useResource<{ positions: TrackedPosition[]; persistence: string }>(`/api/positions?wallet=${encodeURIComponent(address)}`);
  const positions = resource.data?.positions.filter((position) => !live || !position.stub) ?? [];
  const visible = positions.filter((position) => `${position.ticker} ${position.tokenSymbol}`.toLowerCase().includes(query.trim().toLowerCase()));
  const total = positions.reduce((sum, position) => sum + (Number.isFinite(position.usdcIn) ? position.usdcIn : 0), 0);
  const assets = new Set(positions.map((position) => position.tokenSymbol)).size;
  return <>
    <div className={styles.sourceStrip}><span><Icon name="wallet" size={16} />{shortenAddress(address, 6)}</span><button className={styles.refreshButton} onClick={resource.reload}>Refresh fills <Icon name="refresh" size={15} /></button></div>
    {resource.error && <PageError error={resource.error} retry={resource.reload} />}
    {!resource.data ? !resource.error && <Skeleton cards={2} /> : <>
      <dl className={styles.positionMetrics}><div><dt>Historical filled notional</dt><dd>{formatUsd(total)}</dd><small>Not current portfolio value</small></div><div><dt>Tracked assets</dt><dd>{assets}</dd><small>Distinct tokens in your fills</small></div><div><dt>Signed fills</dt><dd>{positions.length}</dd><small>For this wallet address</small></div></dl>
      {!positions.length ? <section className={styles.empty}><h2>No fills recorded yet.</h2><p>Completed, user-approved trades will appear here. An empty history is not a statement about your wallet’s balance.</p><Link className={styles.secondaryButton} href="/">Explore published indexes</Link></section> : <section className={styles.section}>
        <div className={styles.sectionHead}><h2>Your receipts</h2></div><label className={styles.search}><Icon name="search" size={18} /><span className="sr-only">Filter recorded fills by asset</span><input type="search" placeholder="Filter assets…" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
        <div className={styles.tableWrap} role="region" aria-label="Recorded wallet fills, scroll for transaction details" tabIndex={0}><table className={styles.table}><thead><tr><th scope="col">Asset</th><th scope="col">Tokens received</th><th scope="col">USDC filled</th><th scope="col">Date</th><th scope="col">Transaction</th></tr></thead><tbody>{visible.map((position) => <tr key={position.id}><td><strong>{position.tokenSymbol}</strong><small>{position.ticker}{position.stub ? " · Local preview" : ""}</small></td><td>{formatShares(position.tokensOut)}</td><td>{formatUsd(position.usdcIn)}</td><td>{formatDate(position.createdAt)}</td><td><code className={styles.mint}>{position.signature}</code></td></tr>)}</tbody></table></div>
        {!visible.length && <p role="status">No fills match this asset. Try another ticker.</p>}
      </section>}
    </>}
  </>;
}
