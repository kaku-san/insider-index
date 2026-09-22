"use client";

import Link from "next/link";
import Image from "next/image";
import { useEffect, useState } from "react";
import type { Disclosure } from "@/lib/disclosures/types";
import type { PublishedIndex, PublishedIndexResponse } from "@/lib/frontend/research-contract";
import { moneyBand, shortDate } from "@/lib/frontend/research-format";
import { useResource } from "@/lib/frontend/use-resource";
import { errorText } from "@/lib/frontend/api";
import { getIndexPosition, getVaultReadiness, hasIndexShares, publicIndexCanCashOut, publicIndexIsLive, publicIndexStatus, publicIndexStatusCopy, vaultReadinessFromIndex, type IndexSharePosition, type VaultReadiness } from "@/lib/frontend/vault-api";
import { portraitFor } from "@/lib/fomo/portraits";
import { companyNameFor } from "@/lib/frontend/company-logos";
import { indexContentFor } from "@/lib/frontend/index-content";
import { useUI } from "./providers/ui-provider";
import { VaultFlow } from "./vault-flow";
import { usePrivySolana } from "./providers/privy-provider";
import { ShareCard } from "./share-card";
import { Icon } from "./social/icon";
import { PageError, Skeleton, StockIcon } from "./social/shared";
import styles from "./consumer-index.module.css";

const palette = ["#ff5a36", "#171717", "#7e74ff", "#e5a239", "#2e8b73", "#d95d83", "#4387d7", "#8c6f57"];
type Tab = "stocks" | "breakdown" | "moves" | "about";
export type IndexCoverage = {
  tickerCount?: number;
  mappedLegCount?: number;
  vaultReadyLegCount?: number;
  mappableByWeightBps?: number;
  tradableByWeightBps?: number;
  poolReadyOfMappedBps?: number;
};
export type UnmappedIndexLeg = { ticker: string; name?: string | null; bookWeightBps?: number; reason?: string };
export type IndexPerformancePoint = { observedAt: string; value: number };
export type IndexPerformance = { vault: IndexPerformancePoint[]; sp500: IndexPerformancePoint[] };
export type IndexResourceResponse = Omit<PublishedIndexResponse, "index"> & {
  performance?: IndexPerformance;
  index: PublishedIndex & {
    vaultAddress?: string | null;
    shareMint?: string | null;
    network?: "devnet" | "mainnet-beta" | null;
  };
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

function alignedPerformanceReturns(performance?: IndexPerformance): [number, number] | null {
  const series = [performance?.vault ?? [], performance?.sp500 ?? []].map(points => new Map(
    points
      .filter(point => Number.isFinite(point.value) && point.value > 0 && Number.isFinite(Date.parse(point.observedAt)))
      .map(point => [new Date(point.observedAt).toISOString().slice(0, 10), point.value] as const),
  ));
  const dates = [...series[0].keys()].filter(date => series[1].has(date)).sort();
  if (dates.length < 2) return null;
  const first = dates[0];
  const last = dates.at(-1)!;
  return [
    (series[0].get(last)! / series[0].get(first)! - 1) * 100,
    (series[1].get(last)! / series[1].get(first)! - 1) * 100,
  ];
}

export function IndexPerformanceLine({ performance }: { performance?: IndexPerformance }) {
  const returns = alignedPerformanceReturns(performance);
  const vaultReturn = returns?.[0] ?? null;
  const benchmarkReturn = returns?.[1] ?? null;
  const hasDatedVaultValue = (performance?.vault ?? []).some(point => Number.isFinite(point.value) && Number.isFinite(Date.parse(point.observedAt)));
  if (vaultReturn === null || benchmarkReturn === null) {
    return <p className={styles.performanceLine}>Performance versus S&amp;P: {hasDatedVaultValue ? "awaiting a second dated vault value and benchmark series." : "unavailable until a dated vault value exists."}</p>;
  }
  return <p className={styles.performanceLine}>Performance versus S&amp;P: {vaultReturn >= 0 ? "+" : ""}{vaultReturn.toFixed(1)}% vs {benchmarkReturn >= 0 ? "+" : ""}{benchmarkReturn.toFixed(1)}%.</p>;
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
  return <div className={`${styles.holdingsTable} ${styles.simple}`}>
    <div className={styles.holdingsNote}>Every stock in this index, with its published weight.</div>
    <div className={styles.holdingsHead}><span>Stock</span><span>Weight</span></div>
    {sortedHoldings(index).map((item) => <div className={styles.fullHolding} key={item.mint}>
      <div><StockIcon ticker={item.ticker} size="md" /><span><strong>{item.ticker}</strong><small>{companyNameFor(item.ticker, item.issuer)}</small></span></div>
      <b>{(item.weight_bps / 100).toFixed(item.weight_bps >= 1000 ? 1 : 2)}%</b>
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
      <p><strong>{waiting} mapped token{waiting === 1 ? "" : "s"} awaiting pools.</strong> A verified xStock or Backpack mint does not by itself guarantee a usable vault entry and USDC exit route.</p>
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
  const [tab, setTab] = useState<Tab>("stocks");
  const [vault, setVault] = useState<VaultReadiness | null>(null);
  const [vaultError, setVaultError] = useState<string | null>(null);
  const [position, setPosition] = useState<IndexSharePosition | null>(null);
  const [investOpen, setInvestOpen] = useState(false);
  const [investMode, setInvestMode] = useState<"deposit" | "withdraw">("deposit");
  const [shareOpen, setShareOpen] = useState(false);
  const ui = useUI();
  const wallet = usePrivySolana();
  const index = resource.data?.index;

  useEffect(() => {
    let alive = true;
    if (!index || !id) return;
    getVaultReadiness(routeId)
      .then((value) => { if (alive) setVault(value); })
      .catch((error) => { if (alive) setVaultError(errorText(error)); });
    return () => { alive = false; };
  }, [id, index, routeId]);

  useEffect(() => {
    let alive = true;
    if (!id || !wallet.solanaAddress) {
      // Reset the wallet-scoped view when the external wallet identity disappears.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPosition(null);
      return;
    }
    getIndexPosition(routeId, wallet.solanaAddress).then(value => { if (alive) setPosition(value); }).catch(() => { if (alive) setPosition(null); });
    return () => { alive = false; };
  }, [id, routeId, wallet.solanaAddress]);

  if (resource.loading && !index) return <Skeleton />;
  if (resource.error && !index) return <PageError error={resource.error} retry={resource.reload} />;
  if (!index) return null;

  const image = portraitFor(resource.data?.personSlug ?? index.person_id);
  const live = publicIndexIsLive({
    vaultAddress: vault?.identity?.vaultAccount ?? resource.data?.index.vaultAddress,
    shareMint: vault?.identity?.shareMint ?? resource.data?.index.shareMint,
    network: vault?.identity?.network ?? resource.data?.index.network,
    depositsEnabled: resource.data?.depositsEnabled,
    publicFundsEnabled: resource.data?.publicFundsEnabled,
  });
  const status = publicIndexStatus({
    vaultAddress: vault?.identity?.vaultAccount ?? resource.data?.index.vaultAddress,
    shareMint: vault?.identity?.shareMint ?? resource.data?.index.shareMint,
    network: vault?.identity?.network ?? resource.data?.index.network,
    depositsEnabled: resource.data?.depositsEnabled,
    publicFundsEnabled: resource.data?.publicFundsEnabled,
  });
  const availability = id ? (vaultError ?? publicIndexStatusCopy(status)) : publicIndexStatusCopy("Research");
  const resourceReadiness = id && resource.data ? vaultReadinessFromIndex(routeId, resource.data) : null;
  const flowReadiness = vault ?? resourceReadiness;
  const following = ui.deviceFollows.includes(index.person_id);
  const canCashOut = publicIndexCanCashOut(routeId, {
    vaultAddress: vault?.identity?.vaultAccount ?? resource.data?.index.vaultAddress,
    shareMint: vault?.identity?.shareMint ?? resource.data?.index.shareMint,
    network: vault?.identity?.network ?? resource.data?.index.network,
  }) && hasIndexShares(position);
  const excluded = index.definition?.excluded ?? [];
  const holdings = sortedHoldings(index);
  const content = indexContentFor(routeId);
  const summary = content?.portfolioIntro ?? `A public annual-disclosure model led by ${holdings.slice(0, 4).map((item) => companyNameFor(item.ticker, item.issuer)).join(", ")}.`;
  const updated = index.published_at ? new Date(index.published_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }) : "Unavailable";
  const disclosedCount = resource.data?.coverage?.tickerCount ?? index.constituents.length + excluded.length;
  const activityProfileId = id ? resource.data?.activityProfileId : index.person_id;

  return <div className={styles.page}>
    <div className={styles.breadcrumb}><Link href="/"><Icon name="arrow" size={13} style={{ transform: "rotate(180deg)" }} />All indexes</Link><span>{index.indexName ?? "Person index"}</span></div>
    <section className={styles.hero}>
      <div className={styles.image}>{image ? <Image src={image} alt="" fill sizes="126px" unoptimized={image.startsWith("http")} /> : <span className={styles.imageFallback}>{(index.indexName ?? "II").slice(0, 2)}</span>}<b>PERSON INDEX</b></div>
      <div className={styles.heroCopy}>
        <div className={styles.titleLine}><span>Person index</span><em>{index.period ? `${index.period} annual holdings` : "Annual disclosure"}</em></div>
        <h1>{index.indexName ?? "Person index"}</h1>
        <p>{content?.cardHook ?? "The stocks in this index, the mix, and how it was built — in one place."}</p>
        <div className={styles.proof}>{content?.heroProof ?? `${index.constituents.length} stocks`} · updated {updated}</div>
        <div className={styles.actions}>
          {live ? <button type="button" className={styles.primary} onClick={() => { setInvestMode("deposit"); setInvestOpen(true); }}>Invest <Icon name="arrow" size={14} /></button> : null}{canCashOut ? <button type="button" className={styles.secondary} onClick={() => { setInvestMode("withdraw"); setInvestOpen(true); }}>Cash out</button> : null}
          <button type="button" className={live ? styles.tertiary : styles.primary} onClick={() => setShareOpen(true)}><Icon name="share" size={14} />Share</button>
          <button type="button" className={styles.tertiary} aria-pressed={following} onClick={() => ui.toggleDeviceFollow(index.person_id)}><Icon name={following ? "check" : "people"} size={14} />{following ? "Following" : "Follow"}</button>
        </div>
        {!live ? <p className={styles.availability}>{availability}</p> : null}
      </div>
    </section>

    <IndexPerformanceLine performance={resource.data?.performance} />
    <section className={styles.statStrip}>
      <div><span>Stocks</span><strong>{index.constituents.length}</strong><small>{index.period ? `${index.period} holdings` : "published mix"}</small></div>
      <div><span>Names in the source</span><strong>{disclosedCount}</strong></div>
      <div><span>Updated</span><strong>{updated}</strong></div>
      <div><span>Status</span><strong>{status}</strong></div>
    </section>
    <nav className={styles.tabs} aria-label="Index sections">
      {([["stocks", "Stocks"], ["breakdown", "Breakdown"], ["moves", "Moves"], ["about", "About"]] as const).map(([id, label]) => <button type="button" key={id} className={tab === id ? styles.activeTab : ""} onClick={() => setTab(id)}>{label}{id === "stocks" ? <span>{index.constituents.length}</span> : null}</button>)}
    </nav>
    <section className={styles.tabContent}>
      {tab === "stocks" ? <HoldingsTab index={index} /> : null}
      {tab === "breakdown" ? <div className={styles.overviewGrid}>
        <TopHoldings index={index} /><AllocationStrip index={index} />
        <div className={styles.summaryCard}><span>WHAT THIS MIX IS</span><p>{summary}</p><small>Weights come from public filings. They are not a live brokerage account.</small></div>
      </div> : null}
      {tab === "moves" ? (/^[A-Z][0-9]{6}$/.test(activityProfileId ?? "")
        ? <ActivityTab personId={activityProfileId!} />
        : <div className={styles.activityEmpty}><div className={styles.activityIcon}><Icon name="file" size={22} /></div><h3>Person-specific activity is unavailable.</h3><p>This index does not have a verified bioguide identifier, so InsiderIndex will not guess which disclosure rows belong here.</p><Link href="/feed">Open full disclosure feed <Icon name="arrow" size={13} /></Link></div>) : null}
      {tab === "about" ? <div className={styles.aboutGrid}>
        <section><span>HOW IT IS BUILT</span><h3>Public filings, published mix</h3><p>{index.definition?.label ?? "This index is built from a public annual disclosure."}</p>{content?.coverageCopy ? <p>{content.coverageCopy}</p> : null}{excluded.length ? <p>{excluded.length} disclosed names are not in the published mix.</p> : null}</section>
        <section><span>SOURCE</span><h3>Public annual disclosure</h3><p>{index.period ? `Holdings year ${index.period}` : "Holdings year unavailable"} · updated {updated}.</p></section>
        <section className={styles.disclaimer}><span>STATUS</span><h3>{status}</h3><p>{availability}</p></section>
      </div> : null}
    </section>
    <ShareCard open={shareOpen} onClose={() => setShareOpen(false)} title={index.indexName ?? "Person index"} kind="Person index" detail={`${index.constituents.length} stocks`} image={image} />
    <VaultFlow open={investOpen} onClose={() => setInvestOpen(false)} indexId={routeId} indexName={index.indexName ?? "Person index"} readiness={flowReadiness} mode={investMode} position={position} />
  </div>;
}

export function ConsumerIndex({ id }: { id: string }) {
  if (id.startsWith("fmp-")) return <IndexModel hash={id.slice(4)} />;
  if (id.startsWith("insiderindex-")) return <IndexModel id={id} />;
  return <div className={styles.legacy}><h1>Index not found.</h1><Link href="/">Browse all indexes</Link></div>;
}
