"use client";

import Link from "next/link";
import Image from "next/image";
import { useEffect, useMemo, useState } from "react";
import type { Disclosure } from "@/lib/disclosures/types";
import type { PublishedIndex, PublishedIndexResponse } from "@/lib/frontend/research-contract";
import { moneyBand, shortDate } from "@/lib/frontend/research-format";
import { useResource } from "@/lib/frontend/use-resource";
import { errorText } from "@/lib/frontend/api";
import { depositIsEnabled, getVaultReadiness, type VaultReadiness } from "@/lib/frontend/vault-api";
import { portraitFor } from "@/lib/fomo/portraits";
import { companyNameFor } from "@/lib/frontend/company-logos";
import { useUI } from "./providers/ui-provider";
import { VaultFlow } from "./vault-flow";
import { Icon } from "./social/icon";
import { PageError, Skeleton, StockIcon } from "./social/shared";
import styles from "./consumer-index.module.css";

const palette = ["#ff5a36", "#171717", "#7e74ff", "#e5a239", "#2e8b73", "#d95d83", "#4387d7", "#8c6f57"];
type Tab = "overview" | "holdings" | "activity" | "about";
export type IndexCoverage = {
  tickerCount?: number;
  mappedLegCount?: number;
  vaultReadyLegCount?: number;
  mappableByWeightBps?: number;
  tradableByWeightBps?: number;
  poolReadyOfMappedBps?: number;
};
export type UnmappedIndexLeg = { ticker: string; name?: string | null; bookWeightBps?: number; reason?: string };
export type IndexResourceResponse = PublishedIndexResponse & {
  coverageBps?: number | null;
  coverage?: IndexCoverage;
  unmapped?: UnmappedIndexLeg[];
  personSlug?: string;
  activityProfileId?: string | null;
  depositsEnabled?: boolean;
  depositReason?: string | null;
  publicFundsEnabled?: boolean;
};
type ActivityResponse = { disclosures: Disclosure[]; total: number; hasMore?: boolean };

function sortedHoldings(index: PublishedIndex) {
  return [...index.constituents].sort((a, b) => b.weight_bps - a.weight_bps || a.ticker.localeCompare(b.ticker));
}

export function poolReadinessLabel(item: PublishedIndex["constituents"][number]) {
  if (item.pool_status === "observed" || item.vault_ready) return "Pool ready";
  if (item.pool_status === "thin") {
    const tvl = item.pool_tvl_usd == null ? null : item.pool_tvl_usd.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
    return tvl ? `Thin pool · ${tvl} TVL` : "Pool below $10k TVL";
  }
  if (item.pool_status === "none") return "No Raydium–USDC pool";
  return "Pool evidence unavailable";
}

export function IndexPerformancePlaceholder() {
  return <section className={styles.performance} aria-label="Index performance">
    <div className={styles.performanceTop}>
      <div><span>PERFORMANCE</span><strong>—</strong><small>1Y return</small></div>
      <div className={styles.periods} aria-label="Performance period">
        <button type="button">1M</button><button type="button">3M</button><button type="button" className={styles.periodActive}>1Y</button><button type="button">ALL</button>
      </div>
    </div>
    <div className={styles.chartShell}>
      <svg viewBox="0 0 800 180" preserveAspectRatio="none" aria-hidden="true"><path d="M5 118 C95 118, 115 80, 190 96 S305 138, 360 102 S475 74, 545 94 S665 120, 795 86" /></svg>
      <div><strong>Performance series not live yet</strong><span>This panel is ready for a verified dated price series. InsiderIndex does not invent historical returns.</span></div>
    </div>
  </section>;
}

function TopHoldings({ index }: { index: PublishedIndex }) {
  const rows = sortedHoldings(index).slice(0, 5);
  const max = Math.max(...rows.map((item) => item.weight_bps), 1);
  return <div className={styles.topHoldings}>
    <div className={styles.sectionTitle}><div><span>TOP HOLDINGS</span><h3>What&apos;s inside</h3></div><small>{index.constituents.length} mapped names</small></div>
    <div>{rows.map((item, position) => <div className={styles.holdingRow} key={item.mint}>
      <span>{String(position + 1).padStart(2, "0")}</span><StockIcon ticker={item.ticker} size="sm" />
      <div><strong>{item.ticker}</strong><small>{companyNameFor(item.ticker, item.issuer)}</small></div>
      <div className={styles.weightBar}><i style={{ width: `${Math.max(3, item.weight_bps / max * 100)}%` }} /></div>
      <b>{(item.weight_bps / 100).toFixed(item.weight_bps >= 1000 ? 1 : 2)}%</b>
    </div>)}</div>
  </div>;
}

function AllocationStrip({ index }: { index: PublishedIndex }) {
  const rows = sortedHoldings(index).slice(0, 5);
  const shown = rows.reduce((sum, item) => sum + item.weight_bps, 0);
  return <div className={styles.allocationCard}>
    <div className={styles.sectionTitle}><div><span>ALLOCATION</span><h3>Where the weight sits</h3></div><small>{index.constituents.length} holdings</small></div>
    <div className={styles.allocationStrip}>
      {rows.map((item, position) => <i key={item.mint} style={{ width: `${item.weight_bps / 100}%`, background: palette[position % palette.length] }} title={`${item.ticker} ${(item.weight_bps / 100).toFixed(2)}%`} />)}
      {shown < 10_000 ? <i style={{ width: `${(10_000 - shown) / 100}%`, background: "var(--surface-alt)" }} title="Other mapped holdings" /> : null}
    </div>
    <div className={styles.allocationLegend}>{rows.map((item, position) => <div key={item.mint}>
      <i style={{ background: palette[position % palette.length] }} /><StockIcon ticker={item.ticker} size="sm" />
      <span><strong>{item.ticker}</strong><small>{companyNameFor(item.ticker, item.issuer)}</small></span>
      <b>{(item.weight_bps / 100).toFixed(item.weight_bps >= 1000 ? 1 : 2)}%</b>
    </div>)}{shown < 10_000 ? <div className={styles.otherAllocation}><i /><span><strong>Other mapped holdings</strong><small>{Math.max(0, index.constituents.length - rows.length)} remaining names</small></span><b>{((10_000 - shown) / 100).toFixed(1)}%</b></div> : null}</div>
  </div>;
}

function HoldingsTab({ index }: { index: PublishedIndex }) {
  return <div className={styles.holdingsTable}>
    <div className={styles.holdingsNote}>Target weights normalize the token-mapped portion to 100%. Disclosure weights retain each name&apos;s share of the full annual book.</div>
    <div className={styles.holdingsHead}><span>Asset</span><span>Target</span><span>Disclosure</span><span>Token</span><span>Vault route</span></div>
    {sortedHoldings(index).map((item) => <div className={styles.fullHolding} key={item.mint}>
      <div><StockIcon ticker={item.ticker} size="md" /><span><strong>{item.ticker}</strong><small>{companyNameFor(item.ticker, item.issuer)}</small></span></div>
      <b>{(item.weight_bps / 100).toFixed(item.weight_bps >= 1000 ? 1 : 2)}%</b>
      <b>{item.book_weight_bps == null ? "—" : `${(item.book_weight_bps / 100).toFixed(item.book_weight_bps >= 1000 ? 1 : 2)}%`}</b>
      <span>{item.issuer === "xstock" ? "xStock" : "Backpack"}</span>
      <em className={item.vault_ready ? undefined : styles.routeMissing}>{poolReadinessLabel(item)}</em>
    </div>)}
  </div>;
}

export function CoverageBreakdown({ coverage, unmapped }: { coverage?: IndexCoverage; unmapped: UnmappedIndexLeg[] }) {
  if (!coverage) return null;
  const disclosed = coverage.tickerCount ?? (coverage.mappedLegCount ?? 0) + unmapped.length;
  const mapped = coverage.mappedLegCount ?? 0;
  const poolReady = coverage.vaultReadyLegCount ?? 0;
  const catalogPct = (coverage.mappableByWeightBps ?? 0) / 100;
  const tradablePct = (coverage.tradableByWeightBps ?? 0) / 100;
  const waiting = Math.max(0, mapped - poolReady);
  return <section className={styles.coverageCard} aria-label="Token and pool coverage">
    <div className={styles.sectionTitle}><div><span>VAULT COVERAGE</span><h3>What is mapped—and what is usable</h3></div><small>Verified catalog and observed pools</small></div>
    <div className={styles.coverageSteps}>
      <div><strong>{disclosed}</strong><span>disclosed tickers</span><small>Full annual source book</small></div>
      <div><strong>{mapped}</strong><span>token mapped</span><small>{catalogPct.toFixed(1)}% of disclosed weight</small></div>
      <div><strong>{poolReady}</strong><span>pool ready</span><small>{tradablePct.toFixed(1)}% of disclosed weight</small></div>
    </div>
    <div className={styles.coverageNotes}>
      <p><strong>{waiting} mapped token{waiting === 1 ? "" : "s"} without qualifying Raydium–USDC pools.</strong> Issuance does not guarantee a pool; absent pools and pools below $10k TVL stay outside the native vault route.</p>
      {unmapped.length ? <div><span>NO VERIFIED TOKEN</span>{unmapped.map((item) => <span className={styles.unmappedPill} key={item.ticker}>{item.ticker}{item.bookWeightBps ? ` · ${(item.bookWeightBps / 100).toFixed(2)}%` : ""}</span>)}</div> : <div><span>NO VERIFIED TOKEN</span><b>None</b></div>}
    </div>
  </section>;
}

function ActivityTab({ personId }: { personId: string }) {
  const resource = useResource<ActivityResponse>(`/api/disclosures?profileId=${encodeURIComponent(personId)}&limit=25`);
  const rows = resource.data?.disclosures ?? [];
  if (resource.loading && !resource.data) return <Skeleton />;
  if (resource.error && !resource.data) return <PageError error={resource.error} retry={resource.reload} />;
  if (!rows.length) return <div className={styles.activityEmpty}><div className={styles.activityIcon}><Icon name="file" size={22} /></div><h3>No transaction rows in the current source bundle.</h3><p>This does not mean there was no trading activity. It means the committed disclosure source has no dated rows for this person.</p><Link href="/feed">Open full disclosure feed <Icon name="arrow" size={13} /></Link></div>;
  return <div className={styles.activityTable}>
    <div className={styles.activityIntro}><div><span>DISCLOSED ACTIVITY</span><h3>{resource.data?.total ?? rows.length} transaction records</h3></div><p>Information only. These prints never rewrite the annual holdings target.</p></div>
    {rows.map((item) => <article key={item.id}>
      <div><StockIcon ticker={item.ticker} size="md" /><span><strong>{item.ticker}</strong><small>{item.issuerName}</small></span></div>
      <b className={item.side === "buy" ? styles.buy : item.side === "sell" ? styles.sell : undefined}>{item.side === "buy" ? "Bought" : item.side === "sell" ? "Sold" : "Reported"}</b>
      <span><strong>{shortDate(item.transactionDate)}</strong><small>transaction date</small></span>
      <span><strong>{shortDate(item.filedAt)}</strong><small>filed</small></span>
      <span><strong>{moneyBand({ low: item.amountLow, high: item.amountHigh })}</strong><small>disclosed range</small></span>
    </article>)}
    <Link className={styles.activityMore} href="/feed">Open full disclosure feed <Icon name="arrow" size={13} /></Link>
  </div>;
}

function IndexModel({ hash, id }: { hash?: string; id?: string }) {
  const routeId = id ?? `fmp-${hash}`;
  const resource = useResource<IndexResourceResponse>(
    id ? `/api/vault-indexes/${encodeURIComponent(id)}` : `/api/published-indexes/${encodeURIComponent(hash!)}`,
  );
  const [tab, setTab] = useState<Tab>("overview");
  const [vault, setVault] = useState<VaultReadiness | null>(null);
  const [vaultError, setVaultError] = useState<string | null>(null);
  const [investOpen, setInvestOpen] = useState(false);
  const [shareLabel, setShareLabel] = useState("Share");
  const ui = useUI();
  const index = resource.data?.index;

  useEffect(() => {
    let alive = true;
    if (!index) return;
    getVaultReadiness(routeId)
      .then((value) => { if (alive) setVault(value); })
      .catch((error) => { if (alive) setVaultError(errorText(error)); });
    return () => { alive = false; };
  }, [index, routeId]);

  const coverage = useMemo(() => {
    if (!index) return null;
    if (resource.data?.coverageBps != null) return resource.data.coverageBps / 100;
    const evidenceCount = index.definition?.evidence?.length ?? 0;
    return evidenceCount ? index.constituents.length / evidenceCount * 100 : null;
  }, [index, resource.data?.coverageBps]);

  if (resource.loading && !index) return <Skeleton />;
  if (resource.error && !index) return <PageError error={resource.error} retry={resource.reload} />;
  if (!index) return null;

  const image = portraitFor(resource.data?.personSlug ?? index.person_id);
  const live = depositIsEnabled(vault) && (id ? Boolean(resource.data?.depositsEnabled && resource.data.publicFundsEnabled) : true);
  const status = live ? "Live" : "Coming soon";
  const following = ui.deviceFollows.includes(index.person_id);
  const unmapped = resource.data?.unmapped ?? (index.definition?.excluded ?? []).map((item) => ({
    ticker: item.ticker ?? "Unknown",
    name: item.name,
    reason: item.reason,
  }));
  const excluded = index.definition?.excluded ?? [];
  const holdings = sortedHoldings(index);
  const summary = `A public annual-disclosure model led by ${holdings.slice(0, 4).map((item) => companyNameFor(item.ticker, item.issuer)).join(", ")}.`;
  const updated = index.published_at ? new Date(index.published_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }) : "Unavailable";
  const disclosedCount = resource.data?.coverage?.tickerCount ?? index.constituents.length + unmapped.length;
  const poolReadyCount = resource.data?.coverage?.vaultReadyLegCount ?? index.constituents.filter((item) => item.vault_ready).length;
  const tradableCoverage = resource.data?.coverage?.tradableByWeightBps;
  const activityProfileId = id ? resource.data?.activityProfileId : index.person_id;

  async function share() {
    const url = window.location.href;
    try {
      if (navigator.share) await navigator.share({ title: index?.indexName ?? "InsiderIndex", url });
      else {
        await navigator.clipboard.writeText(url);
        setShareLabel("Copied");
        window.setTimeout(() => setShareLabel("Share"), 1800);
      }
    } catch {
      // Cancelling the native share sheet does not need an error state.
    }
  }

  return <div className={styles.page}>
    <div className={styles.breadcrumb}><Link href="/"><Icon name="arrow" size={13} style={{ transform: "rotate(180deg)" }} />All indexes</Link><span>{index.indexName ?? "Person index"}</span></div>
    <section className={styles.hero}>
      <div className={styles.image}>{image ? <Image src={image} alt="" fill sizes="126px" unoptimized={image.startsWith("http")} /> : <span className={styles.imageFallback}>{(index.indexName ?? "II").slice(0, 2)}</span>}<b>PERSON INDEX</b></div>
      <div className={styles.heroCopy}>
        <div className={styles.titleLine}><span>Person index</span><em>{index.period ? `${index.period} annual holdings` : "Annual disclosure"}</em></div>
        <h1>{index.indexName ?? "Person index"}</h1>
        <p>One inspectable target built from the mapped part of a public annual disclosure.</p>
        <div className={styles.proof}>{index.constituents.length} of {disclosedCount} tickers token mapped{coverage == null ? "" : ` · ${coverage.toFixed(1)}% of disclosed weight`} · definition updated {updated}</div>
        <div className={styles.actions}>
          <button type="button" className={styles.primary} onClick={() => setInvestOpen(true)}>{live ? "Invest in index" : "Preview index"}<Icon name="arrow" size={14} /></button>
          <button type="button" className={styles.secondary} onClick={share}><Icon name="share" size={14} />{shareLabel}</button>
          <button type="button" className={styles.tertiary} aria-pressed={following} onClick={() => ui.toggleDeviceFollow(index.person_id)}><Icon name={following ? "check" : "people"} size={14} />{following ? "Following" : "Follow"}</button>
        </div>
      </div>
      <div className={styles.returnHero}><span>1Y RETURN</span><strong>—</strong><small>Awaiting dated series</small></div>
    </section>

    <IndexPerformancePlaceholder />
    <section className={styles.statStrip}>
      <div><span>Disclosed names</span><strong>{disclosedCount}</strong><small>{index.period ? `${index.period} annual holdings` : "annual source book"}</small></div>
      <div><span>Token mapped</span><strong>{index.constituents.length}</strong><small>{coverage == null ? "catalog coverage unavailable" : `${coverage.toFixed(1)}% of disclosed weight`}</small></div>
      <div><span>Pool ready</span><strong>{poolReadyCount}</strong><small>{tradableCoverage == null ? "route coverage unavailable" : `${(tradableCoverage / 100).toFixed(1)}% of disclosed weight`}</small></div>
      <div><span>Status</span><strong>{status}</strong></div>
    </section>
    <nav className={styles.tabs} aria-label="Index sections">
      {([["overview", "Overview"], ["holdings", "Holdings"], ["activity", "Activity"], ["about", "About"]] as const).map(([id, label]) => <button type="button" key={id} className={tab === id ? styles.activeTab : ""} onClick={() => setTab(id)}>{label}{id === "holdings" ? <span>{index.constituents.length}</span> : null}</button>)}
    </nav>
    <section className={styles.tabContent}>
      {tab === "overview" ? <div className={styles.overviewGrid}>
        <TopHoldings index={index} /><AllocationStrip index={index} />
        <CoverageBreakdown coverage={resource.data?.coverage} unmapped={unmapped} />
        <div className={styles.summaryCard}><span>PORTFOLIO SUMMARY</span><p>{summary}</p><small>Weights are annual disclosed holding-value range midpoints, not live positions. Reported trades remain separate activity.</small></div>
      </div> : null}
      {tab === "holdings" ? <HoldingsTab index={index} /> : null}
      {tab === "activity" ? (/^[A-Z][0-9]{6}$/.test(activityProfileId ?? "")
        ? <ActivityTab personId={activityProfileId!} />
        : <div className={styles.activityEmpty}><div className={styles.activityIcon}><Icon name="file" size={22} /></div><h3>Person-specific activity is unavailable.</h3><p>This index does not have a verified bioguide identifier, so InsiderIndex will not guess which disclosure rows belong here.</p><Link href="/feed">Open full disclosure feed <Icon name="arrow" size={13} /></Link></div>) : null}
      {tab === "about" ? <div className={styles.aboutGrid}>
        <section><span>METHODOLOGY</span><h3>How the index is built</h3><p>{index.definition?.label ?? "Mapped annual holdings are normalized into a published target."}</p><p>{excluded.length} disclosed rows are excluded from the mapped target.</p></section>
        <section><span>SOURCE</span><h3>Public annual disclosure</h3><p>{index.period ? `Annual holdings year ${index.period}` : "Holdings year unavailable"} · definition updated {updated}. The model is not a live brokerage balance or NAV.</p></section>
        <section className={styles.disclaimer}><span>VAULT STATUS</span><h3>{status}</h3><p>{vaultError ?? resource.data?.depositReason ?? (live ? "Deposit preparation may return validated native transactions." : "Funding remains disabled until the native vault and public release checks are complete.")}</p></section>
      </div> : null}
    </section>
    <VaultFlow open={investOpen} onClose={() => setInvestOpen(false)} indexId={routeId} indexName={index.indexName ?? "Person index"} readiness={vault} />
  </div>;
}

export function ConsumerIndex({ id }: { id: string }) {
  if (id.startsWith("fmp-")) return <IndexModel hash={id.slice(4)} />;
  if (id.startsWith("insiderindex-")) return <IndexModel id={id} />;
  return <div className={styles.legacy}><h1>Index not found.</h1><Link href="/">Browse all indexes</Link></div>;
}
