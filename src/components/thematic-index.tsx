"use client";

import Link from "next/link";
import Image from "next/image";
import { useEffect, useState } from "react";
import { useResource } from "@/lib/frontend/use-resource";
import type { ThematicIndexView } from "@/lib/thematic/views";
import { indexContentFor, indexProofFor } from "@/lib/frontend/index-content";
import { PageError, Skeleton } from "./social/shared";
import { Icon } from "./social/icon";
import { IndexPerformanceLine, type IndexResourceResponse } from "./consumer-index";
import { ShareCard } from "./share-card";
import { IndexAllocation } from "./index-allocation";
import { themeArtFor } from "@/lib/frontend/theme-art";
import { VaultFlow } from "./vault-flow";
import { TradableSliceNote } from "./tradable-slice-note";
import { usePrivySolana } from "./providers/privy-provider";
import { getIndexPosition, getVaultReadiness, hasIndexShares, navIndexStatus, navSliceLabel, navVaultEnabledFor, navVaultLive, positionValueUsdc, publicIndexIsLive, publicIndexStatus, publicIndexStatusCopy, vaultReadinessFromIndex, type IndexSharePosition, type VaultReadiness } from "@/lib/frontend/vault-api";
import { markedDollars } from "@/lib/frontend/research-format";
import { positionHoldingFigures } from "@/lib/frontend/position-share-copy";
import { plainStatusForOperation } from "@/lib/frontend/settlement-progress";
import { useIndexPositionListen } from "@/lib/frontend/use-position-listen";
import { usePositionRefresh } from "@/lib/frontend/use-position-refresh";
import { changeReflected } from "@/lib/frontend/position-refresh";
import type { PublicVaultDefinition } from "@/lib/index-vaults/vault-definition-store";
import styles from "./consumer-index.module.css";

type Payload = { index: ThematicIndexView; storage: string };
type Tab = "allocation" | "about";

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
  const [tab, setTab] = useState<Tab>("allocation");
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
    if ((vaultId !== "idx-theme-mag7-caucus" && !navVaultEnabledFor(vaultId)) || !wallet.solanaAddress) return () => { alive = false; };
    const key = `${vaultId}:${wallet.solanaAddress}`;
    getIndexPosition(vaultId, wallet.solanaAddress).then(value => { if (alive) { setPosition(value); setLoadedPositionKey(key); } }).catch(error => { if (alive) { setPosition(null); setLoadedPositionKey(null); setPositionError(error instanceof Error ? error.message : "Your share balance is unavailable right now."); setPositionErrorKey(key); } });
    return () => { alive = false; };
  }, [vaultId, wallet.solanaAddress, positionRefresh]);
  const positionKey = wallet.solanaAddress ? `${vaultId}:${wallet.solanaAddress}` : null;
  const currentPosition = loadedPositionKey === positionKey ? position : null;
  useIndexPositionListen(vaultId, wallet.solanaAddress, currentPosition, value => { setPosition(value); if (wallet.solanaAddress) setLoadedPositionKey(`${vaultId}:${wallet.solanaAddress}`); }, !investOpen);
  const positionRefreshState = usePositionRefresh<IndexSharePosition | null>({
    owner: wallet.solanaAddress,
    indexId: vaultId,
    load: () => getIndexPosition(vaultId, wallet.solanaAddress!),
    apply: value => { if (!wallet.solanaAddress) return; setPosition(value); setLoadedPositionKey(`${vaultId}:${wallet.solanaAddress}`); },
    reflected: (value, change) => changeReflected(change, value),
    enabled: vaultId === "idx-theme-mag7-caucus" || navVaultEnabledFor(vaultId),
  });
  if (resource.loading && !resource.data) return <Skeleton />;
  if (resource.error && !resource.data) return <PageError error={resource.error} retry={resource.reload} />;
  if (!index) return null;

  const holdings = [...index.constituents].sort((a, b) => b.weight_bps - a.weight_bps);
  const content = indexContentFor(vaultId);
  const art = themeArtFor(index.id);
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
  const disclosedSlice = vault?.kind === "nav-vault" && navSliceLabel(vault) ? vault.slice : null;

  return <div className={styles.page}>
    <div className={styles.breadcrumb}><Link href="/"><Icon name="arrow" size={13} style={{ transform: "rotate(180deg)" }} />All indexes</Link><span>{index.indexName}</span></div>
    <section className={styles.hero}>
      <div className={`${styles.image} ${styles.themeImage}`}><Image src={art?.src ?? `/index-assets/themes/${index.id}-hero.png`} alt={art?.alt ?? ""} fill sizes="(max-width: 560px) 82px, 148px" /></div>
      <div className={styles.heroCopy}>
        <div className={styles.titleLine}><span>Theme index</span><em>{index.members.length} members</em></div>
        <h1>{index.indexName}</h1>
        <p>{content?.cardHook ?? index.headline}</p>
        <div className={styles.proof}>{indexProofFor({ holdingCount: holdings.length, memberCount: index.members.length })} · updated {updated}</div>
        <div className={styles.actions}>
          {live ? <button type="button" className={styles.primary} disabled={Boolean(activeOperation)} onClick={() => { setInvestMode("deposit"); setInvestOpen(true); }}>Invest <Icon name="arrow" size={14} /></button> : null}
          <button type="button" className={live ? styles.tertiary : styles.primary} onClick={() => setShareOpen(true)}><Icon name="share" size={14} />Share</button>
        </div>
        {!live ? <p className={styles.availability}>{availability}</p> : null}
        {disclosedSlice ? <TradableSliceNote readiness={vault} className={styles.availability} /> : null}
        {positionRefreshState.updating ? <p className={styles.ownedPosition} role="status" aria-live="polite" data-position-updating="true">Your position: <strong>Updating…</strong> <Link href={`/positions/${encodeURIComponent(vaultId)}`}>View position</Link></p> : ownedFigures ? <p className={styles.ownedPosition}>Your position: <strong>{ownedFigures[0].text}</strong> {ownedFigures[0].label}. {ownedFigures[1].text} {ownedFigures[1].label}. <Link href={`/positions/${encodeURIComponent(vaultId)}`}>View position</Link></p> : null}
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
      {([["allocation", "Allocation"], ["about", "About"]] as const).map(([tabId, label]) => <button type="button" key={tabId} className={tab === tabId ? styles.activeTab : ""} onClick={() => setTab(tabId)}>{label}{tabId === "allocation" ? <span>{holdings.length}</span> : null}</button>)}
    </nav>
    <section className={styles.tabContent}>
      {/* Theme constituent mints are the mainnet catalog assets; independent of the vault deployment network. */}
      {tab === "allocation" ? <IndexAllocation slice={disclosedSlice} items={holdings.map(item => ({ ticker: item.ticker, name: item.name, weightBps: item.weight_bps, mint: item.mint, issuer: item.issuer, tokenSymbol: item.venueSymbol, network: "mainnet-beta" }))} /> : null}
      {tab === "about" ? <div className={styles.aboutGrid}>
        <section><span>HOW IT IS BUILT</span><h3>About this index</h3><p>{content?.portfolioIntro ?? index.whyItExists}</p><p>{index.rule}</p></section>
        <section><span>SOURCE</span><h3>Where the data comes from</h3><p>{index.sourceLine}</p><p>{index.members.length} members.</p></section>
        <section className={styles.disclaimer}><span>STATUS</span><h3>{status}</h3><p>{availability}</p></section>
      </div> : null}
    </section>
    <ShareCard open={shareOpen} onClose={() => setShareOpen(false)} title={index.indexName} kind="Theme index" detail={`${holdings.length} stocks`} image={art?.src ?? `/index-assets/themes/${index.id}-hero.png`} />
    <VaultFlow open={investOpen} onClose={() => { setInvestOpen(false); setPositionRefresh(current => current + 1); }} onPosition={value => { if (!value || !wallet.solanaAddress) return; setPosition(value); setLoadedPositionKey(`${vaultId}:${wallet.solanaAddress}`); }} indexId={vaultId} indexName={index.indexName} readiness={readiness} indexKind="theme" mode={investMode} position={currentPosition} />
  </div>;
}
