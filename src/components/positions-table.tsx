"use client";

import { useState } from "react";
import Link from "next/link";
import { usePrivySolana } from "./providers/privy-provider";
import { useResource } from "@/lib/frontend/use-resource";
import { PREVIEW_MODE } from "@/lib/frontend/api";
import { formatReceiptAmount, type TrackedPosition } from "@/lib/position-contract";
import { formatVaultShares } from "@/lib/index-vaults/positions-contract";
import type { IndexSharePosition } from "@/lib/frontend/vault-api";
import { Icon } from "./social/icon";
import { PageError, Skeleton, StockIcon } from "./social/shared";
import { WalletButton } from "./wallet-button";
import { formatDate, shortenAddress } from "@/lib/format";
import { portraitFor } from "@/lib/fomo/portraits";
import styles from "./consumer-positions.module.css";

type CopyReceipts = { positions: TrackedPosition[] };
type IndexPositionsResponse = { positions: IndexSharePosition[] };
type Tab = "indexes" | "copies";

export function PositionsTable() {
  const wallet = usePrivySolana();
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<Tab>("indexes");
  const connected = wallet.mode === "live" && wallet.authenticated && wallet.solanaAddress;
  const copies = useResource<CopyReceipts>(connected ? `/api/positions/copies?wallet=${encodeURIComponent(connected)}` : null);
  const indexes = useResource<IndexPositionsResponse>(connected ? `/api/positions/indexes?wallet=${encodeURIComponent(connected)}` : null);
  const fills = copies.data?.positions ?? [];
  const ownedIndexes = indexes.data?.positions ?? [];
  const pendingIndexOperations = ownedIndexes.flatMap(position => position.pendingOperations?.filter(operation => !operation.complete) ?? []);
  const visible = fills.filter((p) => `${p.ticker} ${p.tokenSymbol}`.toLowerCase().includes(query.toLowerCase()));

  if (!connected) {
    return (
      <div className={styles.page}>
        <header className={styles.hero}>
          <div>
            <span>YOUR INSIDERINDEX</span>
            <h1>Your famous-people funds,<br />in one place.</h1>
            <p>Connect to see native index shares, resumable operations and the individual disclosures you copied.</p>
          </div>
          <Link href="/">Explore indexes <Icon name="arrow" size={14} /></Link>
        </header>
        <div className={styles.connectStage}>
          <div className={styles.connectArt}>
            <div className={styles.portraits}>
              <img src={portraitFor("nancy-pelosi") ?? ""} alt="" />
              <img src={portraitFor("jensen-huang") ?? ""} alt="" />
              <img src={portraitFor("tim-cook") ?? ""} alt="" />
            </div>
            <span>YOUR PORTFOLIO</span>
          </div>
          <div className={styles.connectCopy}>
            <small>CONNECT TO CONTINUE</small>
            <h2>The app is public.<br />Your positions aren&apos;t.</h2>
            <p>
              {wallet.mode === "unavailable"
                ? "Wallet connection is unavailable. Retry to reload Privy. We won’t substitute a demo wallet."
                : "Following and research work without a wallet. Connecting only reveals your index shares and copy receipts; it never authorizes a transaction."}
            </p>
            <WalletButton />
            <span className={styles.safe}><Icon name="shield" size={14} /> Every invest, copy and exit gets its own approval.</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <header className={styles.portfolioHead}>
        <div>
          <span>YOUR PORTFOLIO</span>
          <h1>My positions</h1>
          <p>
            {PREVIEW_MODE
              ? "Interactive flow preview · values below are labelled design fixtures."
              : "Your index shares and copied moves for this wallet."}
          </p>
        </div>
        <div className={styles.walletPill}>
          <i />
          <code>{shortenAddress(connected, 7)}</code>
          <WalletButton />
        </div>
      </header>

      <section className={styles.balance}>
        <div>
          <span>INDEX SHARE VALUE</span>
          <strong>—</strong>
          <small>Share counts come from chain reads. A dollar value is shown only when one is verified.</small>
        </div>
        <div className={styles.balanceStats}>
          <span><b>{indexes.loading ? "—" : ownedIndexes.length}</b> index {ownedIndexes.length === 1 ? "position" : "positions"}</span>
          <span><b>{fills.length}</b> copied moves</span>
          <span><b>{indexes.loading ? "—" : pendingIndexOperations.length}</b> settlement{pendingIndexOperations.length === 1 ? "" : "s"} pending</span>
        </div>
        <Link href="/">Explore <Icon name="arrow" size={13} /></Link>
      </section>

      <div className={styles.tabs}>
        <button className={tab === "indexes" ? styles.active : ""} onClick={() => setTab("indexes")}>
          Index positions
        </button>
        <button className={tab === "copies" ? styles.active : ""} onClick={() => setTab("copies")}>
          Copied moves <b>{fills.length}</b>
        </button>
      </div>

      {tab === "indexes" ? (
        <section className={styles.indexSection}>
          <div className={styles.sectionTitle}>
            <div>
              <h2>Your indexes</h2>
              <p>Your shares in each index. These are read directly from your wallet.</p>
            </div>
          </div>
          {indexes.loading ? <Skeleton cards={2} /> : indexes.error ? <PageError error={indexes.error} retry={indexes.reload} /> : !ownedIndexes.length ? <div className={styles.empty}>
            <Icon name="grid" size={26} />
            <h2>No index shares yet.</h2>
            <p>When you own shares in an index, they will appear here.</p>
            <Link href="/">Explore indexes <Icon name="arrow" size={13} /></Link>
          </div> : <div className={styles.indexGrid}>{ownedIndexes.map(position => {
            const pending = position.pendingOperations?.filter(operation => !operation.complete) ?? [];
            return <Link className={styles.indexCard} key={position.indexId} href={`/positions/${encodeURIComponent(position.indexId)}`}>
              <div className={styles.indexBody}><div className={styles.indexTop}><small>INDEX SHARES</small></div><h3>{position.indexName ?? "Index"}</h3><div className={styles.indexNumbers}><span><b>{formatVaultShares(position.sharesRaw, position.shareDecimals ?? 0)}</b><small>shares owned</small></span><span><b>{position.markedValueUsdc ?? "—"}</b><small>{position.markedValueUsdc == null ? "value unavailable" : "verified value"}</small></span></div>{pending.length ? <div className={styles.pending}><i />{pending[0].kind === "withdraw" ? "Cash out pending settlement" : "Deposit pending settlement"}</div> : null}</div>
            </Link>;
          })}</div>}
        </section>
      ) : null}

      {tab === "copies" ? (
        <section className={styles.copySection}>
          <div className={styles.sectionTitle}>
            <div>
              <h2>Copied moves</h2>
              <p>Receipts from individual public disclosures you personally chose to sign. Not vault NAV.</p>
            </div>
            {fills.length ? (
              <label className={styles.search}>
                <Icon name="search" size={14} />
                <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter" aria-label="Filter fills" />
              </label>
            ) : null}
          </div>
          {copies.loading ? <Skeleton cards={2} /> : copies.error ? <PageError error={copies.error} retry={copies.reload} /> : fills.some((p) => p.wallet !== connected) ? (
            <p role="alert">Receipt wallet mismatch. No receipts are shown.</p>
          ) : !fills.length ? (
            <div className={styles.empty}>
              <Icon name="file" size={26} />
              <h2>No copied moves yet.</h2>
              <p>Eligible one-leg disclosures appear in Feed.</p>
              <Link href="/feed">Open Feed <Icon name="arrow" size={13} /></Link>
            </div>
          ) : (
            <div className={styles.list}>
              {visible.map((p) => (
                <article className={styles.row} key={p.id}>
                  <StockIcon ticker={p.ticker} />
                  <div className={styles.asset}>
                    <strong>{p.tokenSymbol}</strong>
                    <small>{p.side === "buy" ? "Buy" : "Sell"} · {p.ticker}</small>
                  </div>
                  <div className={styles.notional}>
                    <strong>{formatReceiptAmount(p.inputAmountRaw, p.inputDecimals)}</strong>
                    <small>{p.side === "buy" ? "USDC paid" : `${p.tokenSymbol} sold`}</small>
                  </div>
                  <div className={styles.details}>
                    <small>{formatDate(p.createdAt)}</small>
                    {p.stub ? <em>DEVELOPMENT FIXTURE</em> : <code title={p.signature}>{shortenAddress(p.signature, 6)}</code>}
                  </div>
                </article>
              ))}
              {!visible.length ? <div className={styles.empty}><p>No fills match this search.</p></div> : null}
            </div>
          )}
        </section>
      ) : null}

      <div className={styles.foot}>
        <Icon name="info" size={14} />
        <p>Copy fills, vault shares, redemption claims and converted USDC are separate objects. InsiderIndex never adds them together into a fabricated portfolio number.</p>
      </div>
    </div>
  );
}
