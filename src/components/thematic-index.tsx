"use client";

import Link from "next/link";
import Image from "next/image";
import { useEffect, useState } from "react";
import { useResource } from "@/lib/frontend/use-resource";
import type { ThematicIndexView } from "@/lib/thematic/views";
import { companyNameFor } from "@/lib/frontend/company-logos";
import { PageError, Skeleton, StockIcon } from "./social/shared";
import { Icon } from "./social/icon";
import { CoverageBreakdown, IndexPerformancePlaceholder, type IndexResourceResponse } from "./consumer-index";
import { ShareCard } from "./share-card";
import { VaultFlow } from "./vault-flow";
import { depositIsEnabled, getVaultReadiness, type VaultReadiness } from "@/lib/frontend/vault-api";
import styles from "./consumer-index.module.css";

type Payload = { index: ThematicIndexView; storage: string };
type Tab = "overview" | "holdings" | "activity" | "about";
const palette = ["#ff5a36", "#171717", "#7e74ff", "#e5a239", "#2e8b73", "#d95d83", "#4387d7", "#8c6f57"];

export function ThematicIndexPage({ id, initialData }: { id: string; initialData?: Payload }) {
  const resource = useResource<Payload>(`/api/thematic-indexes/${encodeURIComponent(id)}`, initialData);
  const vaultResource = useResource<IndexResourceResponse>(`/api/vault-indexes/${encodeURIComponent(id)}`);
  const [tab, setTab] = useState<Tab>("overview");
  const [shareOpen, setShareOpen] = useState(false);
  const [investOpen, setInvestOpen] = useState(false);
  const [vault, setVault] = useState<VaultReadiness | null>(null);
  useEffect(() => {
    let alive = true;
    getVaultReadiness(id).then(value => { if (alive) setVault(value); }).catch(() => { if (alive) setVault(null); });
    return () => { alive = false; };
  }, [id]);
  if (resource.loading && !resource.data) return <Skeleton />;
  if (resource.error && !resource.data) return <PageError error={resource.error} retry={resource.reload} />;
  const index = resource.data?.index;
  if (!index) return null;

  const holdings = [...index.constituents].sort((a, b) => b.weight_bps - a.weight_bps);
  const top = holdings.slice(0, 5);
  const max = Math.max(...top.map((item) => item.weight_bps), 1);
  const shown = top.reduce((sum, item) => sum + item.weight_bps, 0);
  const updated = new Date(index.sourceGeneratedAt ?? index.generatedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
  const coverage = vaultResource.data?.coverage;
  const mappedCount = coverage?.mappedLegCount ?? holdings.length;
  const disclosedCount = coverage?.tickerCount ?? mappedCount + (vaultResource.data?.unmapped?.length ?? 0);
  const catalogCoverage = coverage?.mappableByWeightBps == null ? null : coverage.mappableByWeightBps / 100;
  const poolReadyCount = coverage?.vaultReadyLegCount ?? 0;
  const tradableCoverage = coverage?.tradableByWeightBps == null ? null : coverage.tradableByWeightBps / 100;
  const readinessByTicker = new Map(vaultResource.data?.index.constituents.map((item) => [item.ticker, item.vault_ready]) ?? []);
  const live = depositIsEnabled(vault);
  const hasVault = Boolean(vault?.identity);
  const availability = vault?.blockers?.[0] ?? "This index does not have a live vault yet.";

  return <div className={styles.page}>
    <div className={styles.breadcrumb}><Link href="/"><Icon name="arrow" size={13} style={{ transform: "rotate(180deg)" }} />All indexes</Link><span>{index.indexName}</span></div>
    <section className={styles.hero}>
      <div className={styles.image}><Image src={`/index-assets/themes/${index.id}-hero.png`} alt="" fill sizes="126px" /><b>THEME INDEX</b></div>
      <div className={styles.heroCopy}>
        <div className={styles.titleLine}><span>Theme index</span><em>{index.members.length} members</em></div>
        <h1>{index.indexName}</h1>
        <p>{index.headline}</p>
        <div className={styles.proof}>{mappedCount} of {disclosedCount} tickers token mapped{catalogCoverage == null ? "" : ` · ${catalogCoverage.toFixed(1)}% of research weight`} · research updated {updated}</div>
        <div className={styles.actions}>
          {live ? <button type="button" className={styles.primary} onClick={() => setInvestOpen(true)}>Invest in index <Icon name="arrow" size={14} /></button> : <Link className={styles.primary} href="#holdings">View holdings <Icon name="arrow" size={14} /></Link>}
          <button type="button" className={styles.secondary} onClick={() => setShareOpen(true)}><Icon name="share" size={14} />Share</button>
        </div>
        {!live ? <p className={styles.availability}>{availability}</p> : null}
      </div>
      <div className={styles.returnHero}><span>1Y RETURN</span><strong>—</strong><small>Awaiting dated series</small></div>
    </section>

    <IndexPerformancePlaceholder />
    <section className={styles.statStrip}>
      <div><span>Research names</span><strong>{disclosedCount}</strong></div>
      <div><span>Token mapped</span><strong>{mappedCount}</strong><small>{catalogCoverage == null ? "catalog coverage loading" : `${catalogCoverage.toFixed(1)}% of research weight`}</small></div>
      <div><span>Pool ready</span><strong>{poolReadyCount}</strong><small>{tradableCoverage == null ? "route coverage loading" : `${tradableCoverage.toFixed(1)}% of research weight`}</small></div>
      <div><span>Status</span><strong>{live ? "Live" : hasVault ? "Deposits closed" : "Research only"}</strong></div>
    </section>
    <nav className={styles.tabs} aria-label="Index sections">
      {([["overview", "Overview"], ["holdings", "Holdings"], ["activity", "Activity"], ["about", "About"]] as const).map(([tabId, label]) => <button id={tabId === "holdings" ? "holdings" : undefined} type="button" key={tabId} className={tab === tabId ? styles.activeTab : ""} onClick={() => setTab(tabId)}>{label}{tabId === "holdings" ? <span>{holdings.length}</span> : null}</button>)}
    </nav>
    <section className={styles.tabContent}>
      {tab === "overview" ? <div className={styles.overviewGrid}>
        <div className={styles.topHoldings}>
          <div className={styles.sectionTitle}><div><span>TOP HOLDINGS</span><h3>What&apos;s inside</h3></div><small>{holdings.length} mapped names</small></div>
          <div>{top.map((item, position) => <div className={styles.holdingRow} key={item.mint}>
            <span>{String(position + 1).padStart(2, "0")}</span><StockIcon ticker={item.ticker} size="sm" />
            <div><strong>{item.ticker}</strong><small>{companyNameFor(item.ticker, item.name)}</small></div>
            <div className={styles.weightBar}><i style={{ width: `${Math.max(3, item.weight_bps / max * 100)}%` }} /></div><b>{(item.weight_bps / 100).toFixed(item.weight_bps >= 1000 ? 1 : 2)}%</b>
          </div>)}</div>
        </div>
        <div className={styles.allocationCard}>
          <div className={styles.sectionTitle}><div><span>ALLOCATION</span><h3>Where the weight sits</h3></div><small>{holdings.length} holdings</small></div>
          <div className={styles.allocationStrip}>{top.map((item, position) => <i key={item.mint} style={{ width: `${item.weight_bps / 100}%`, background: palette[position % palette.length] }} title={`${item.ticker} ${(item.weight_bps / 100).toFixed(2)}%`} />)}{shown < 10_000 ? <i style={{ width: `${(10_000 - shown) / 100}%`, background: "var(--surface-alt)" }} title="Other holdings" /> : null}</div>
          <div className={styles.allocationLegend}>{top.map((item, position) => <div key={item.mint}><i style={{ background: palette[position % palette.length] }} /><StockIcon ticker={item.ticker} size="sm" /><span><strong>{item.ticker}</strong><small>{companyNameFor(item.ticker, item.name)}</small></span><b>{(item.weight_bps / 100).toFixed(item.weight_bps >= 1000 ? 1 : 2)}%</b></div>)}</div>
        </div>
        <CoverageBreakdown coverage={coverage} unmapped={vaultResource.data?.unmapped ?? []} />
        <div className={styles.summaryCard}><span>PORTFOLIO SUMMARY</span><p>{index.narrative}</p><small>{live ? "This multi-member thematic basket is a research model. Deposit preparation is available when the native vault gate is open." : `${availability} This multi-member thematic basket remains a research model without a deposit, basket Buy or NAV.`}</small></div>
      </div> : null}
      {tab === "holdings" ? <div className={styles.holdingsTable}>
        <div className={styles.holdingsNote}>Research weights are the published thematic target. Pool readiness separately shows whether each mapped token has an observed native vault route.</div>
        <div className={styles.holdingsHead}><span>Asset</span><span>Target</span><span>Research</span><span>Token</span><span>Vault route</span></div>
        {holdings.map((item) => {
          const ready = readinessByTicker.get(item.ticker);
          return <div className={styles.fullHolding} key={item.mint}><div><StockIcon ticker={item.ticker} size="md" /><span><strong>{item.ticker}</strong><small>{companyNameFor(item.ticker, item.name)}</small></span></div><b>{(item.weight_bps / 100).toFixed(item.weight_bps >= 1000 ? 1 : 2)}%</b><b>{(item.weight_bps / 100).toFixed(item.weight_bps >= 1000 ? 1 : 2)}%</b><span>{item.issuer === "xstock" ? "xStock" : "Backpack"}</span><em className={ready === true ? undefined : styles.routeMissing}>{ready === true ? "Pool ready" : ready === false ? "No observed pool" : "Route unavailable"}</em></div>;
        })}
      </div> : null}
      {tab === "activity" ? <div className={styles.activityEmpty}><div className={styles.activityIcon}><Icon name="file" size={22} /></div><h3>This theme is built from disclosed evidence.</h3><p>The basket is a research model, not a transaction-led portfolio. Individual public prints remain on the separate feed.</p><Link href="/feed">Open disclosure feed <Icon name="arrow" size={13} /></Link></div> : null}
      {tab === "about" ? <div className={styles.aboutGrid}>
        <section><span>METHODOLOGY</span><h3>How the index is built</h3><p>{index.rule}</p><p>{index.whyItExists}</p></section>
        <section><span>SOURCE</span><h3>Where the data comes from</h3><p>{index.sourceLine}</p><p>{index.members.length} members · {index.rebalance}.</p></section>
        <section className={styles.disclaimer}><span>IMPORTANT</span><h3>{live ? "Deposit preparation available" : hasVault ? "Deposits closed" : "Research only"}</h3><p>{live ? "Investing opens a verified native preparation flow. Shares, costs and wallet approvals are shown only after preparation." : availability}</p></section>
      </div> : null}
    </section>
    <ShareCard open={shareOpen} onClose={() => setShareOpen(false)} title={index.indexName} kind="Theme index" detail={`${holdings.length} mapped names · thematic research model`} image={`/index-assets/themes/${index.id}-hero.png`} />
    <VaultFlow open={investOpen} onClose={() => setInvestOpen(false)} indexId={id} indexName={index.indexName} readiness={vault} indexKind="theme" />
  </div>;
}
