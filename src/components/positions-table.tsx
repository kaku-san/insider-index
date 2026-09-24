"use client";

import Link from "next/link";
import { useEffect } from "react";
import { usePrivySolana } from "./providers/privy-provider";
import { useResource } from "@/lib/frontend/use-resource";
import { PREVIEW_MODE, readApi } from "@/lib/frontend/api";
import { usePositionRefresh } from "@/lib/frontend/use-position-refresh";
import { changeReflected, positionInList } from "@/lib/frontend/position-refresh";
import { positionValueUsdc, type IndexSharePosition } from "@/lib/frontend/vault-api";
import { positionHoldingFigures } from "@/lib/frontend/position-share-copy";
import { positionBookLine } from "@/lib/frontend/position-basket";
import { markedDollars } from "@/lib/frontend/research-format";
import { plainStatusForOperation, positionNeedsListen, SETTLEMENT_POLL_MS } from "@/lib/frontend/settlement-progress";
import { Icon } from "./social/icon";
import { PageError, Skeleton } from "./social/shared";
import { WalletButton } from "./wallet-button";
import { shortenAddress } from "@/lib/format";
import { portraitFor } from "@/lib/fomo/portraits";
import styles from "./consumer-positions.module.css";

type IndexPositionsResponse = { positions: IndexSharePosition[] };

export function PositionsTable() {
  const wallet = usePrivySolana();
  const connected = wallet.mode === "live" && wallet.authenticated && wallet.solanaAddress;
  const positionsUrl = connected ? `/api/positions/indexes?wallet=${encodeURIComponent(connected)}` : null;
  const indexes = useResource<IndexPositionsResponse>(positionsUrl);
  // After a confirmed deposit/cash-out (or on focus) re-read at once; poll until the new share balance shows.
  const refresh = usePositionRefresh<IndexPositionsResponse>({
    owner: connected || null,
    indexId: null,
    load: () => readApi<IndexPositionsResponse>(positionsUrl!),
    apply: indexes.replace,
    reflected: (value, change) => changeReflected(change, positionInList(value.positions, change.indexId)),
    enabled: Boolean(positionsUrl),
  });
  const updatingIds = new Set(refresh.updatingIndexIds);
  const ownedIndexes = indexes.data?.positions ?? [];
  const pendingIndexOperations = ownedIndexes.flatMap(position => position.pendingOperations?.filter(operation => !operation.complete) ?? []);
  const listenKey = ownedIndexes.filter(position => positionNeedsListen(position)).map(position => position.indexId).join(",");
  useEffect(() => {
    if (!listenKey) return;
    const timer = setInterval(() => indexes.reload(), SETTLEMENT_POLL_MS);
    return () => clearInterval(timer);
  }, [listenKey, indexes.reload]);

  if (!connected) {
    return (
      <div className={styles.page}>
        <header className={styles.hero}>
          <div>
            <span>YOUR INSIDERINDEX</span>
            <h1>Your famous-people funds,<br />in one place.</h1>
            <p>Connect to see native index shares and resumable operations.</p>
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
                : "Following and research work without a wallet. Connecting only reveals your index shares; it never authorizes a transaction."}
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
              : "USDC value for each index. Share counts are raw mint units from your wallet, not a price."}
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
          <span><b>{indexes.loading || refresh.updating ? "—" : ownedIndexes.length}</b> index {ownedIndexes.length === 1 ? "position" : "positions"}</span>
          <span><b>{indexes.loading || refresh.updating ? "—" : pendingIndexOperations.length}</b> settlement{pendingIndexOperations.length === 1 ? "" : "s"} pending</span>
          {refresh.updating ? <span role="status" aria-live="polite" data-position-updating="true">Updating…</span> : null}
        </div>
        <Link href="/">Explore <Icon name="arrow" size={13} /></Link>
      </section>

      <section className={styles.indexSection}>
          <div className={styles.sectionTitle}>
            <div>
              <h2>Your indexes</h2>
              <p>USDC value is the number to read. Share counts are raw mint units, not a price.</p>
            </div>
          </div>
          {indexes.loading && !indexes.data ? <Skeleton cards={2} /> : indexes.error ? <PageError error={indexes.error} retry={indexes.reload} /> : !ownedIndexes.length && refresh.updating ? <div className={styles.empty} role="status" aria-live="polite" data-position-updating="true">
            <Icon name="refresh" size={26} />
            <h2>Updating…</h2>
            <p>Your signed transaction confirmed. Waiting for your share balance to show.</p>
          </div> : !ownedIndexes.length ? <div className={styles.empty}>
            <Icon name="grid" size={26} />
            <h2>No index shares yet.</h2>
            <p>When you own shares in an index, they will appear here.</p>
            <Link href="/">Explore indexes <Icon name="arrow" size={13} /></Link>
          </div> : <div className={styles.indexGrid}>{ownedIndexes.map(position => {
            const pending = position.pendingOperations?.filter(operation => !operation.complete) ?? [];
            const valueText = markedDollars(positionValueUsdc(position) ?? position.markedValueUsdc);
            const figures = positionHoldingFigures({ sharesRaw: position.sharesRaw, shareDecimals: position.shareDecimals, valueText });
            const bookLine = positionBookLine(position);
            return <Link className={styles.indexCard} key={position.indexId} href={`/positions/${encodeURIComponent(position.indexId)}`}>
              <div className={styles.indexBody}><div className={styles.indexTop}><small>INDEX VALUE</small></div><h3>{position.indexName ?? "Index"}</h3>{updatingIds.has(position.indexId) ? <div className={styles.indexNumbers} role="status" aria-live="polite" data-position-updating="true"><span className={styles.valueLead}><b>Updating…</b><small>Waiting for your new share balance</small></span></div> : <div className={styles.indexNumbers}>{figures.map(figure => <span key={figure.role} className={figure.primary ? styles.valueLead : undefined}><b>{figure.text}</b><small>{figure.label}</small></span>)}</div>}{bookLine ? <p className={styles.bookLine}>{bookLine}</p> : null}{pending.length ? <div className={styles.pending} data-settlement-status={plainStatusForOperation(pending[0])} aria-busy={positionNeedsListen(position) ? true : undefined}><i />{plainStatusForOperation(pending[0])}</div> : null}</div>
            </Link>;
          })}</div>}
        </section>

      <div className={styles.foot}>
        <Icon name="info" size={14} />
        <p>Copy fills, vault shares, redemption claims and converted USDC are separate objects. InsiderIndex never adds them together into a fabricated portfolio number.</p>
      </div>
    </div>
  );
}
