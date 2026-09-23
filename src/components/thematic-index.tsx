"use client";

import Link from "next/link";
import Image from "next/image";
import { useEffect, useState } from "react";
import { useResource } from "@/lib/frontend/use-resource";
import type { ThematicIndexView } from "@/lib/thematic/views";
import { companyNameFor } from "@/lib/frontend/company-logos";
import { indexContentFor } from "@/lib/frontend/index-content";
import { PageError, Skeleton, StockIcon } from "./social/shared";
import { Icon } from "./social/icon";
import { IndexPerformanceLine, type IndexResourceResponse } from "./consumer-index";
import { ShareCard } from "./share-card";
import { VaultFlow } from "./vault-flow";
import { TradableSliceNote } from "./tradable-slice-note";
import { usePrivySolana } from "./providers/privy-provider";
import { getIndexPosition, getVaultReadiness, hasIndexShares, navIndexStatus, navVaultEnabledFor, navVaultLive, positionValueUsdc, publicIndexIsLive, publicIndexStatus, publicIndexStatusCopy, vaultReadinessFromIndex, type IndexSharePosition, type VaultReadiness } from "@/lib/frontend/vault-api";
import { markedDollars } from "@/lib/frontend/research-format";
import { positionHoldingFigures } from "@/lib/frontend/position-share-copy";
import { plainStatusForOperation } from "@/lib/frontend/settlement-progress";
import { useIndexPositionListen } from "@/lib/frontend/use-position-listen";
import { PUBLIC_MAG7 } from "@/lib/index-vaults/public-cycle-parse";
import type { PublicVaultDefinition } from "@/lib/index-vaults/vault-definition-store";
import styles from "./consumer-index.module.css";

type Payload = { index: ThematicIndexView; storage: string };
type Tab = "stocks" | "breakdown" | "about";
const palette = ["#ff5a36", "#171717", "#7e74ff", "#e5a239", "#2e8b73", "#d95d83", "#4387d7", "#8c6f57"];

function vaultState(definition?: PublicVaultDefinition | null, payload?: IndexResourceResponse | null, readiness?: VaultReadiness | null) {
  return {
    vaultAddress: readiness?.identity?.vaultAccount ?? payload?.index.vaultAddress ?? definition?.vaultAddress,
    shareMint: readiness?.identity?.shareMint ?? payload?.index.shareMint ?? definition?.shareMint,
    network: readiness?.identity?.network ?? payload?.index.network ?? definition?.network,
    depositsEnabled: payload?.depositsEnabled ?? definition?.depositsEnabled,
    publicFundsEnabled: payload?.publicFundsEnabled ?? definition?.publicFundsEnabled,
  };
}

export function ThematicIndexPage({ id, initialData, initialVault }: { id: string; initialData?: Payload; initialVault?: PublicVaultDefinition | null }) {
  const resource = useResource<Payload>(`/api/thematic-indexes/${encodeURIComponent(id)}`, initialData);
  const index = resource.data?.index;
  const vaultId = index?.id ?? (id.startsWith("idx-theme-") ? id : `idx-theme-${id}`);
  const vaultResource = useResource<IndexResourceResponse>(`/api/vault-indexes/${encodeURIComponent(vaultId)}`);
  const [tab, setTab] = useState<Tab>("stocks");
  const [shareOpen, setShareOpen] = useState(false);
  const [investOpen, setInvestOpen] = useState(false);
  const [investMode, setInvestMode] = useState<"deposit" | "withdraw">("deposit");
  const [vault, setVault] = useState<VaultReadiness | null>(null);
  const [vaultLoaded, setVaultLoaded] = useState(false);
  const [position, setPosition] = useState<IndexSharePosition | null>(null);
  const [loadedPositionKey, setLoadedPositionKey] = useState<string | null>(null);
  const [positionError, setPositionError] = useState<string | null>(null);
  const [positionErrorKey, setPositionErrorKey] = useState<string | null>(null);
  const [positionRefresh, setPositionRefresh] = useState(0);
  const wallet = usePrivySolana();
  useEffect(() => {
    let alive = true;
    getVaultReadiness(vaultId).then(value => { if (alive) { setVault(value); setVaultLoaded(true); } }).catch(() => { if (alive) setVault(null); });
    return () => { alive = false; };
  }, [vaultId]);
  useEffect(() => {
    let alive = true;
    if ((vaultId !== PUBLIC_MAG7.indexId && !navVaultEnabledFor(vaultId)) || !wallet.solanaAddress) return () => { alive = false; };
    const key = `${vaultId}:${wallet.solanaAddress}`;
    getIndexPosition(vaultId, wallet.solanaAddress).then(value => { if (alive) { setPosition(value); setLoadedPositionKey(key); } }).catch(error => { if (alive) { setPosition(null); setLoadedPositionKey(null); setPositionError(error instanceof Error ? error.message : "Your share balance is unavailable right now."); setPositionErrorKey(key); } });
    return () => { alive = false; };
  }, [vaultId, wallet.solanaAddress, positionRefresh]);
  const positionKey = wallet.solanaAddress ? `${vaultId}:${wallet.solanaAddress}` : null;
  const currentPosition = loadedPositionKey === positionKey ? position : null;
  useIndexPositionListen(vaultId, wallet.solanaAddress, currentPosition, value => { setPosition(value); if (wallet.solanaAddress) setLoadedPositionKey(`${vaultId}:${wallet.solanaAddress}`); }, !investOpen);
  if (resource.loading && !resource.data) return <Skeleton />;
  if (resource.error && !resource.data) return <PageError error={resource.error} retry={resource.reload} />;
  if (!index) return null;

  const holdings = [...index.constituents].sort((a, b) => b.weight_bps - a.weight_bps);
  const content = indexContentFor(vaultId);
  const top = holdings.slice(0, 5);
  const max = Math.max(...top.map((item) => item.weight_bps), 1);
  const shown = top.reduce((sum, item) => sum + item.weight_bps, 0);
  const updated = new Date(index.sourceGeneratedAt ?? index.generatedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
  const liveState = vaultState(initialVault, vaultResource.data, vault);
  // Until the NAV readiness read resolves, the server-rendered DB state stands in (no flash of "Research").
  const live = (vaultLoaded ? navVaultLive(vaultId, vault) : null) ?? publicIndexIsLive(liveState);
  const status = (vaultLoaded ? navIndexStatus(vaultId, vault) : null) ?? publicIndexStatus(liveState);
  const availability = publicIndexStatusCopy(status);
  const pendingOperations = currentPosition?.pendingOperations?.filter(operation => !operation.complete) ?? [];
  const activeOperation = pendingOperations[0] ?? null;
  const ownedFigures = hasIndexShares(currentPosition) && currentPosition ? positionHoldingFigures({ sharesRaw: currentPosition.sharesRaw, shareDecimals: currentPosition.shareDecimals, valueText: markedDollars(positionValueUsdc(currentPosition) ?? currentPosition.markedValueUsdc) }) : null;
  const readiness = vault ?? (initialVault ? vaultReadinessFromIndex(vaultId, {
    index: { vaultAddress: initialVault.vaultAddress, shareMint: initialVault.shareMint, network: initialVault.network },
    depositsEnabled: initialVault.depositsEnabled,
    publicFundsEnabled: vaultResource.data?.publicFundsEnabled,
  }) : null);

  return <div className={styles.page}>
    <div className={styles.breadcrumb}><Link href="/"><Icon name="arrow" size={13} style={{ transform: "rotate(180deg)" }} />All indexes</Link><span>{index.indexName}</span></div>
    <section className={styles.hero}>
      <div className={styles.image}><Image src={`/index-assets/themes/${index.id}-hero.png`} alt="" fill sizes="126px" /><b>THEME INDEX</b></div>
      <div className={styles.heroCopy}>
        <div className={styles.titleLine}><span>Theme index</span><em>{index.members.length} members</em></div>
        <h1>{index.indexName}</h1>
        <p>{content?.cardHook ?? index.headline}</p>
        <div className={styles.proof}>{content?.heroProof ?? `${holdings.length} stocks`} · {index.members.length} members · updated {updated}</div>
        <div className={styles.actions}>
          {live ? <button type="button" className={styles.primary} disabled={Boolean(activeOperation)} onClick={() => { setInvestMode("deposit"); setInvestOpen(true); }}>Invest <Icon name="arrow" size={14} /></button> : null}
          <button type="button" className={live ? styles.tertiary : styles.primary} onClick={() => setShareOpen(true)}><Icon name="share" size={14} />Share</button>
        </div>
        {!live ? <p className={styles.availability}>{availability}</p> : null}
        {live ? <TradableSliceNote readiness={vault} className={styles.availability} /> : null}
        {ownedFigures ? <p className={styles.ownedPosition}>Your position: <strong>{ownedFigures[0].text}</strong> {ownedFigures[0].label}. {ownedFigures[1].text} {ownedFigures[1].label}. <Link href={`/positions/${encodeURIComponent(vaultId)}`}>View position</Link></p> : null}
        {activeOperation ? <p className={styles.ownedPosition} data-settlement-status={plainStatusForOperation(activeOperation)}>{plainStatusForOperation(activeOperation)}{activeOperation.phase === "FAILED" ? ". This deposit did not finish the basket. It is not shares." : "."} <Link href={`/positions/${encodeURIComponent(vaultId)}`}>View status</Link></p> : null}
        {positionErrorKey === positionKey && positionError ? <p className={styles.availability}>{positionError}</p> : null}
      </div>
    </section>

    <IndexPerformanceLine performance={vaultResource.data?.performance} />
    <section className={styles.statStrip}>
      <div><span>Stocks</span><strong>{holdings.length}</strong></div>
      <div><span>Members</span><strong>{index.members.length}</strong></div>
      <div><span>Updated</span><strong>{updated}</strong></div>
      <div><span>Status</span><strong>{status}</strong></div>
    </section>
    <nav className={styles.tabs} aria-label="Index sections">
      {([["stocks", "Stocks"], ["breakdown", "Breakdown"], ["about", "About"]] as const).map(([tabId, label]) => <button type="button" key={tabId} className={tab === tabId ? styles.activeTab : ""} onClick={() => setTab(tabId)}>{label}{tabId === "stocks" ? <span>{holdings.length}</span> : null}</button>)}
    </nav>
    <section className={styles.tabContent}>
      {tab === "stocks" ? <div className={`${styles.holdingsTable} ${styles.simple}`}>
        <div className={styles.holdingsNote}>Target mix — these seven names are the published allocation, not what a last deposit bought.</div>
        <div className={styles.holdingsHead}><span>Stock</span><span>Weight</span></div>
        {holdings.map((item) => <div className={styles.fullHolding} key={item.mint}><div><StockIcon ticker={item.ticker} size="md" /><span><strong>{item.ticker}</strong><small>{companyNameFor(item.ticker, item.name)}</small></span></div><b>{(item.weight_bps / 100).toFixed(item.weight_bps >= 1000 ? 1 : 2)}%</b></div>)}
      </div> : null}
      {tab === "breakdown" ? <div className={styles.overviewGrid}>
        <div className={styles.topHoldings}>
          <div className={styles.sectionTitle}><div><span>TOP HOLDINGS</span><h3>What&apos;s inside</h3></div><small>{holdings.length} stocks</small></div>
          <div>{top.map((item, position) => <div className={styles.holdingRow} key={item.mint}>
            <span>{String(position + 1).padStart(2, "0")}</span><StockIcon ticker={item.ticker} size="sm" />
            <div><strong>{item.ticker}</strong><small>{companyNameFor(item.ticker, item.name)}</small></div>
            <div className={styles.weightBar}><i style={{ width: `${Math.max(3, item.weight_bps / max * 100)}%` }} /></div><b>{(item.weight_bps / 100).toFixed(item.weight_bps >= 1000 ? 1 : 2)}%</b>
          </div>)}</div>
        </div>
        <div className={styles.allocationCard}>
          <div className={styles.sectionTitle}><div><span>BREAKDOWN</span><h3>Where the weight sits</h3></div><small>{holdings.length} holdings</small></div>
          <div className={styles.allocationStrip}>{top.map((item, position) => <i key={item.mint} style={{ width: `${item.weight_bps / 100}%`, background: palette[position % palette.length] }} title={`${item.ticker} ${(item.weight_bps / 100).toFixed(2)}%`} />)}{shown < 10_000 ? <i style={{ width: `${(10_000 - shown) / 100}%`, background: "var(--surface-alt)" }} title="Other holdings" /> : null}</div>
          <div className={styles.allocationLegend}>{top.map((item, position) => <div key={item.mint}><i style={{ background: palette[position % palette.length] }} /><StockIcon ticker={item.ticker} size="sm" /><span><strong>{item.ticker}</strong><small>{companyNameFor(item.ticker, item.name)}</small></span><b>{(item.weight_bps / 100).toFixed(item.weight_bps >= 1000 ? 1 : 2)}%</b></div>)}</div>
        </div>
        <div className={styles.summaryCard}><span>WHAT THIS MIX IS</span><p>{content?.portfolioIntro ?? index.narrative}</p><small>Weights come from public filings. They are not a live brokerage account.</small></div>
      </div> : null}
      {tab === "about" ? <div className={styles.aboutGrid}>
        <section><span>HOW IT IS BUILT</span><h3>Public filings, published mix</h3><p>{index.whyItExists}</p><p>{index.rule}</p></section>
        <section><span>SOURCE</span><h3>Where the data comes from</h3><p>{index.sourceLine}</p><p>{index.members.length} members.</p></section>
        <section className={styles.disclaimer}><span>STATUS</span><h3>{status}</h3><p>{availability}</p></section>
      </div> : null}
    </section>
    <ShareCard open={shareOpen} onClose={() => setShareOpen(false)} title={index.indexName} kind="Theme index" detail={`${holdings.length} stocks`} image={`/index-assets/themes/${index.id}-hero.png`} />
    <VaultFlow open={investOpen} onClose={() => { setInvestOpen(false); setPositionRefresh(current => current + 1); }} onPosition={value => { if (!value || !wallet.solanaAddress) return; setPosition(value); setLoadedPositionKey(`${vaultId}:${wallet.solanaAddress}`); }} indexId={vaultId} indexName={index.indexName} readiness={readiness} indexKind="theme" mode={investMode} position={currentPosition} />
  </div>;
}
