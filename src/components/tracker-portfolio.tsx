"use client";

import Link from "next/link";
import { useId } from "react";
import { disclosedRange } from "@/lib/frontend/disclosure-labels";
import type { TrackerPersonView } from "@/lib/tracker/views";
import type { TrackerProfile, TrackerTrade } from "@/lib/tracker/tracker-parse";
import type { Comparison, ShownBook } from "@/lib/tracker/shown-book";
import { poolReadiness, type MainnetRaydiumPool } from "@/lib/index-vaults/raydium-pools-mainnet";
import { Icon } from "./social/icon";
import { TableRegion, portfolioStyles as styles } from "./person-portfolio";

const usd = (value: number) => value.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const usdCompact = (value: number) => value.toLocaleString("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1 });
const pct = (value: number, digits = 2) => `${value.toFixed(digits)}%`;
const longDate = (value: string) => new Date(`${value}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

/** Every PelosiTracker figure wears this chip so it cannot be mistaken for a filing or a NAV. */
export function TrackerTag({ asOf, variant = "tracker", children }: { asOf: string; variant?: "tracker" | "fmp" | "both"; children?: React.ReactNode }) {
  return <span className={styles.sourceTag} data-source={variant}>{children ?? `PelosiTracker · as of ${longDate(asOf)}`}</span>;
}

export function TrackerHeroStats({ profile, index }: { profile: TrackerProfile; index: TrackerPersonView["index"] }) {
  const value = profile.portfolio.valueUsd;
  const change = profile.portfolio.monthlyChangePercent;
  return <dl className={styles.stats} aria-label="PelosiTracker portfolio statistics">
    <div><dt>PelosiTracker portfolio value</dt><dd>{value !== null ? usdCompact(value) : "—"}</dd><small>Politician-API third-party estimate as of {longDate(profile.asOf)}. Not net worth, not a vault NAV{profile.copyTrade?.totalValueUsd != null ? `, and not the copy-trade book (${usdCompact(profile.copyTrade.totalValueUsd)})` : ""}.</small></div>
    <div><dt>PelosiTracker 30-day change</dt><dd data-tone={change === null ? undefined : change < 0 ? "negative" : "positive"}>{change === null ? "—" : `${change > 0 ? "+" : ""}${change.toFixed(2)}%`}</dd><small>Tracker model figure, not a verified return.</small></div>
    <div><dt>Tracker positions shown</dt><dd>{profile.topHoldings.length}</dd><small>{profile.holdingsBasis === "copy-trade-full" ? `Copy-trade book, ${profile.topHoldings.length} itemized names. Different $ total from the disclosure estimate. Not a NAV.` : `Top ${profile.coverage.holdingsSlice} slice + OTHER aggregate, not every lot filed. Tickers are not invented for OTHER.`}</small></div>
    <div><dt>Vault-ready names</dt><dd>{index.constituents.length}</dd><small>{index.readiness.status === "VAULT_CANDIDATE" ? "Composition candidate · funds disabled" : "Waiting on readiness"}</small></div>
  </dl>;
}

function PoolCell({ mint, pools }: { mint: string | null; pools: MainnetRaydiumPool[] }) {
  if (!mint) return <><strong>No Solana mint</strong><small>Not in the xStock / Backpack catalog</small></>;
  const readiness = poolReadiness(mint, pools);
  if (readiness.status === "none") return <><strong>No Raydium USDC pool observed</strong><small>Listed on the book; excluded from vault weights</small></>;
  return <><span className={styles.readiness} data-status={readiness.status}>{readiness.status === "observed" ? "Raydium pool observed" : "Raydium pool too thin"}</span><small>{readiness.pool!.kind === "raydium_clmm" ? "CLMM" : "CPMM"} · TVL {usdCompact(readiness.pool!.tvlUsd)} · observed {longDate(readiness.pool!.observedAt.slice(0, 10))}</small></>;
}

export function ShownBookPanel({ book, view, fmpReferenceLabel }: { book: ShownBook; view: TrackerPersonView; fmpReferenceLabel: string | null }) {
  const tokens = new Map(view.holdingTokens.map((entry) => [entry.ticker, entry.token]));
  return <section id="shown-book" className={styles.panel} aria-labelledby="shown-book-title">
    <div className={styles.sectionHead}>
      <div><h2 id="shown-book-title">Current positions · shown book</h2><p>{view.profile.holdingsBasis === "copy-trade-full" ? `PelosiTracker copy-trade book first (${view.profile.topHoldings.length} names, current as of ${longDate(book.asOf)}; different $ total from the politician-API disclosure estimate)` : `PelosiTracker positions first (top ${view.profile.coverage.holdingsSlice} + OTHER as of ${longDate(book.asOf)})`}, then the older FMP annual disclosure rows{fmpReferenceLabel ? ` (${fmpReferenceLabel})` : ""}. Readings are never one total.</p></div>
      <TrackerTag asOf={book.asOf} />
    </div>
    <p className={styles.caption}>{book.note}</p>
    <TableRegion label="Shown book: tracker positions and annual disclosure rows">
      <table className={`${styles.table} ${styles.holdingsTable}`}>
        <thead><tr><th scope="col">Asset</th><th scope="col">Source &amp; date</th><th scope="col" className={styles.number}>PelosiTracker reading</th><th scope="col" className={styles.number}>Annual filing band</th><th scope="col">Solana mapping · Raydium pool</th></tr></thead>
        <tbody>{book.rows.map((row) => {
          const token = row.ticker ? tokens.get(row.ticker) ?? null : null;
          const mint = token?.mint ?? row.token?.mint ?? null;
          const mapped = token ? `${token.issuer === "xstock" ? "xStock" : "Backpack"} · ${token.symbol}` : row.token ? `${row.token.issuer === "xstock" ? "xStock" : "Backpack"} · ${row.token.symbol}` : null;
          return <tr key={row.key}>
            <td><div className={styles.tickerCell}><span className={styles.tickerMark}>{(row.ticker ?? row.name ?? "?").slice(0, 2)}</span><span><strong>{row.ticker ?? row.name ?? "Unnamed disclosure"}</strong>{row.ticker && row.name && <small>{row.name}</small>}</span></div></td>
            <td>{row.source === "both" ? <TrackerTag asOf={book.asOf} variant="both">Tracker {longDate(book.asOf)} + annual filing</TrackerTag> : row.source === "tracker" ? <TrackerTag asOf={book.asOf} /> : <TrackerTag asOf={book.asOf} variant="fmp">FMP annual filing{row.fmp?.referenceDate ? ` · ${row.fmp.referenceDate}` : ""}</TrackerTag>}</td>
            <td className={styles.number}>{row.tracker ? <><strong>{row.tracker.percentage !== null ? pct(row.tracker.percentage) : "—"}</strong><small>{row.tracker.valueUsd !== null ? `${usd(row.tracker.valueUsd)} ${view.profile.holdingsBasis === "copy-trade-full" && row.ticker ? "copy-trade MTM" : "tracker est."}` : "No tracker value"}</small></> : <><strong>—</strong><small>Not in tracker {view.profile.holdingsBasis === "copy-trade-full" ? "copy-trade book" : `top ${view.profile.coverage.holdingsSlice}`}</small></>}</td>
            <td className={styles.number}>{row.fmp ? row.fmp.rows.map((item) => <div key={item.id}><strong>{disclosedRange(item.valueRange)}</strong><small>{item.kind}{item.owner ? ` · ${item.owner}` : ""}</small></div>) : <><strong>—</strong><small>Not on the saved annual filing</small></>}</td>
            <td>{row.key === "tracker:OTHER" ? <><strong>Unitemized OTHER</strong><small>No tickers invented</small></> : mapped ? <><strong>{mapped}</strong><PoolCell mint={mint} pools={view.pools} /></> : <PoolCell mint={null} pools={view.pools} />}</td>
          </tr>;
        })}</tbody>
      </table>
    </TableRegion>
    <div className={styles.panelFooter}><span>{book.counts.tracker} tracker positions · {book.counts.fmpAnnual} annual rows · {book.counts.both} on both</span><span>Raydium pool evidence observed {longDate(view.poolSnapshot.fetchedAt.slice(0, 10))}</span></div>
  </section>;
}

export function TrackerSectors({ profile }: { profile: TrackerProfile }) {
  return <section className={styles.panel} aria-labelledby="sectors-title">
    <div className={styles.sectionHead}><div><h2 id="sectors-title">Sector mix</h2><p>PelosiTracker’s sector split of its modelled book, including uninvested cash.</p></div><TrackerTag asOf={profile.asOf} /></div>
    {profile.sectors.length ? <div className={styles.sectorBars}>{profile.sectors.map((sector) => <div className={styles.sectorBar} key={sector.sector}><span>{sector.sector}</span><span className={styles.sectorTrack} data-cash={/cash/i.test(sector.sector)} aria-hidden="true"><span style={{ width: `${Math.min(100, Math.max(0, sector.percentage))}%` }} /></span><span>{pct(sector.percentage)}</span></div>)}</div> : <p className={styles.caption}>PelosiTracker published no sector split for this member.</p>}
    <p className={styles.caption}>Sector percentages are the tracker’s own classification of its estimate; they are not derived from filings by InsiderIndex and do not drive any index weight.</p>
  </section>;
}

function tradeAmount(trade: TrackerTrade) {
  if (trade.amountBand) return disclosedRange(trade.amountBand);
  return trade.amountEstimateUsd !== null ? `≈ ${usd(trade.amountEstimateUsd)} (tracker estimate)` : "Amount not given";
}

export function TrackerTrades({ profile }: { profile: TrackerProfile }) {
  const groups = profile.recentTrades.reduce((map, trade) => {
    const key = trade.date ?? trade.dateLabel;
    map.set(key, [...(map.get(key) ?? []), trade]);
    return map;
  }, new Map<string, TrackerTrade[]>());
  return <section id="tracker-trades" className={styles.panel} aria-labelledby="tracker-trades-title">
    <div className={styles.sectionHead}>
      <div><h2 id="tracker-trades-title">Recent trades · information only</h2><p>PelosiTracker’s most recent {profile.coverage.tradesSlice} reported trades. Shown for context; never an input to any index weight.</p></div>
      <TrackerTag asOf={profile.asOf} />
    </div>
    <p className={styles.caption}>Amounts are disclosure bands decoded from the tracker’s band midpoints. A label like “Quarterly” is the source’s own text where no date was given; a date after the scrape is kept as published and flagged.</p>
    {!profile.recentTrades.length ? <div className={styles.empty}><h3>No recent trades in the handoff</h3><p>PelosiTracker listed no trades for this member. This is not evidence of no trading.</p></div> :
      <div className={styles.timeline}>{[...groups.entries()].map(([key, trades]) => <section className={styles.timelineGroup} key={key}>
        <div className={styles.timelineDate}><strong>{trades[0].date ? longDate(trades[0].date) : trades[0].dateLabel}</strong><span>{trades.length} {trades.length === 1 ? "trade" : "trades"}{trades[0].date ? "" : " · source label, not a date"}</span></div>
        <div className={styles.timelineRows}>{trades.map((trade) => <article className={styles.timelineRow} key={trade.ordinal}>
          <div className={styles.tradeMain}><span className={styles.event} data-side={trade.side}>{trade.sourceType ?? "Trade"}</span><div><strong>{trade.ticker}</strong><small>{trade.filingStatus ? `Filing status: ${trade.filingStatus}` : "Filing status not given"}{trade.notificationDate ? ` · notified ${trade.notificationDate}` : ""}{trade.flags.includes("after-scrape-date") ? " · dated after the scrape (kept as published)" : ""}</small></div></div>
          <div className={styles.tradeAmount}><span>{trade.amountBand ? "Disclosure band" : "PelosiTracker amount"}</span><strong>{tradeAmount(trade)}</strong></div>
        </article>)}</div>
      </section>)}</div>}
  </section>;
}

export function TrackerFilingStats({ profile }: { profile: TrackerProfile }) {
  const stats = profile.filingStats;
  const days = (value: number | null) => (value === null ? "—" : `${value}d`);
  const count = (value: number | null) => (value === null ? "—" : value.toLocaleString("en-US"));
  return <section className={styles.panel} aria-labelledby="filing-stats-title">
    <div className={styles.sectionHead}><div><h2 id="filing-stats-title">Filing stats</h2><p>PelosiTracker’s filing statistics for this member.</p></div><TrackerTag asOf={profile.asOf} /></div>
    {stats.tracked ? <dl className={styles.statGrid}>
      <div><dt>Average reporting time</dt><dd>{days(stats.averageReportingTimeDays)}</dd><small>Trade date → disclosure</small></div>
      <div><dt>Between filings</dt><dd>{days(stats.averageTimeBetweenFilingsDays)}</dd><small>Average gap</small></div>
      <div><dt>Since last filing</dt><dd>{days(stats.daysSinceLastFiling)}</dd><small>Counted at the scrape date</small></div>
      <div><dt>Total filings</dt><dd>{count(stats.totalFilings)}</dd><small>PTR filings seen by the tracker</small></div>
      <div><dt>Total transactions</dt><dd>{count(stats.totalTransactions)}</dd><small>Lines across those filings</small></div>
    </dl> : <div className={styles.empty}><h3>Not tracked by PelosiTracker for this member</h3><p>The handoff carries zero or empty filing statistics here (the tracker does not compute them for Senate rows). This is missing tracker coverage, not a record of zero filings.</p></div>}
  </section>;
}

export function TrackerSeries({ profile }: { profile: TrackerProfile }) {
  const id = useId().replaceAll(":", "");
  const points = profile.performance.points.slice(profile.performance.leadingZeroPoints);
  const width = 620, height = 180;
  const values = points.map((p) => p.valueUsd);
  const min = values.length ? Math.min(...values) : 0, max = values.length ? Math.max(...values) : 0, span = max - min || 1;
  const line = points.map((p, i) => `${(i / Math.max(1, points.length - 1)) * width},${height - 16 - ((p.valueUsd - min) / span) * (height - 32)}`).join(" ");
  const last = points.at(-1) ?? null;
  return <section className={`${styles.panel} ${styles.performance}`} aria-labelledby="tracker-series-title">
    <div className={styles.sectionHead}><div><h2 id="tracker-series-title">PelosiTracker portfolio value series</h2><p>The tracker’s daily estimate of the modelled book. Not a NAV, not a return, not a benchmark comparison.</p></div><TrackerTag asOf={profile.asOf} /></div>
    {points.length >= 2 ? <div className={styles.seriesChart}>
      <div className={styles.seriesTopline}><span>{points.length.toLocaleString("en-US")} daily points · {longDate(points[0].date)} → {longDate(last!.date)}</span><span>Latest tracker estimate <strong>{usd(last!.valueUsd)}</strong></span></div>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`PelosiTracker estimated portfolio value series from ${points[0].date} to ${last!.date}; latest ${usd(last!.valueUsd)}. Third-party model, not a NAV.`}>
        <defs><linearGradient id={`tracker-fill-${id}`} x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor="var(--purple-text)" stopOpacity=".18" /><stop offset="100%" stopColor="var(--purple-text)" stopOpacity="0" /></linearGradient></defs>
        {[30, 90, 150].map((y) => <line key={y} x1="0" x2={width} y1={y} y2={y} stroke="var(--border)" strokeDasharray="3 6" />)}
        <polygon points={`0,${height} ${line} ${width},${height}`} fill={`url(#tracker-fill-${id})`} />
        <polyline fill="none" stroke="var(--purple-text)" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" points={line} />
      </svg>
      <div className={styles.seriesLabels}><span>{longDate(points[0].date)} · {usdCompact(points[0].valueUsd)}</span><span>Range {usdCompact(min)} – {usdCompact(max)}</span><span>{longDate(last!.date)} · {usdCompact(last!.valueUsd)}</span></div>
    </div> : <div className={styles.emptyChart}><div className={styles.emptyMetric}>—</div><h3>No tracker series in the handoff</h3><p>PelosiTracker published no value series for this member.</p></div>}
    <p className={styles.caption}>Series as scraped {longDate(profile.asOf)}. {profile.performance.leadingZeroPoints ? `${profile.performance.leadingZeroPoints} leading zero-value points from before the tracker had positions are kept in the data but not drawn. ` : ""}InsiderIndex computes no return from it and draws no S&amp;P 500 overlay.</p>
  </section>;
}

export function TrackerIndexPanel({ view }: { view: TrackerPersonView }) {
  const { index } = view;
  return <section id="tracker-index" className={styles.panel} aria-labelledby="tracker-index-title">
    <div className={styles.sectionHead}>
      <div><h2 id="tracker-index-title">Vault-ready index · tracker positions</h2><p>{index.indexName}. The investable slice of the shown current book: catalog mint + observed Raydium USDC pool, weighted by the tracker’s position percentages renormalized to 10,000 bps.</p></div>
      <span className={styles.readiness} data-status={index.readiness.status}>{index.readiness.status === "VAULT_CANDIDATE" ? (index.readiness.firstLiveCandidate ? "Vault candidate · first live candidate" : "Vault candidate") : "Wait readiness"}</span>
    </div>
    <p className={styles.caption}>{index.label} {index.navDisclaimer} Recent trades are never an input.</p>
    {index.constituents.length ? <TableRegion label="Tracker-positions index weights, scroll for mint and pool addresses">
      <table className={`${styles.table} ${styles.holdingsTable}`}>
        <thead><tr><th scope="col">Asset</th><th scope="col" className={styles.number}>Tracker position</th><th scope="col" className={styles.number}>Target weight</th><th scope="col">Solana mint</th><th scope="col">Raydium USDC pool</th></tr></thead>
        <tbody>{index.constituents.map((row) => <tr key={row.token.mint}>
          <td><div className={styles.tickerCell}><span className={styles.tickerMark}>{row.ticker.slice(0, 2)}</span><span><strong>{row.ticker}</strong><small>{row.token.issuer === "xstock" ? "xStock" : "Backpack"} · {row.token.symbol}</small></span></div></td>
          <td className={styles.number}><strong>{pct(row.trackerPercentage)}</strong><small>of tracker book · {longDate(index.asOf)}</small></td>
          <td className={styles.number}><strong>{pct(row.weightBps / 100)}</strong><div className={styles.weightTrack} aria-hidden="true"><span style={{ width: `${Math.min(100, row.weightBps / 100)}%` }} /></div></td>
          <td><code className={styles.mint}>{row.token.mint}</code></td>
          <td><code className={styles.mint}>{row.pool.pool}</code><small>{row.pool.kind === "raydium_clmm" ? "CLMM" : "CPMM"} · TVL {usdCompact(row.pool.tvlUsd)} · observed {longDate(row.pool.observedAt.slice(0, 10))}</small></td>
        </tr>)}</tbody>
      </table>
    </TableRegion> : <div className={styles.empty}><h3>No investable slice yet</h3><p>None of the tracker’s listed positions has both a Solana catalog mint and an observed Raydium USDC pool. The positions stay on the shown book above; nothing is substituted.</p></div>}
    <details className={styles.coverage}><summary>Readiness, coverage and excluded names</summary>
      <p>Weights sum to {index.constituents.reduce((sum, row) => sum + row.weightBps, 0).toLocaleString("en-US")} bps over {index.constituents.length} names covering {pct(index.coverage.includedTrackerPercentage)} of the tracker book ({pct(index.coverage.listedTrackerPercentage)} listed in the top {index.coverage.holdingsSlice}).</p>
      <ul className={styles.reasonList}>{index.readiness.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>
      {index.excluded.length ? <ul className={styles.reasonList}>{index.excluded.map((row) => <li key={`${row.ticker}-${row.reason}`}>{row.ticker}{row.trackerPercentage !== null ? ` (${pct(row.trackerPercentage)})` : ""}: {row.reason.replaceAll("-", " ")}{row.token ? ` · ${row.token.symbol}` : ""}</li>)}</ul> : null}
      <p>Public funds remain disabled ({view.release.status}). Exit is USDC only: no in-kind bag of xStocks, and exit stays off until a USDC-out quote exists and the 0 bps host exit fee is what the transaction does. Pool evidence from Raydium’s API, observed {longDate(view.poolSnapshot.fetchedAt.slice(0, 10))}; re-verify before any deployer step.</p>
    </details>
    <div className={styles.panelFooter}><span>Basis: PelosiTracker positions · trades not used</span><Link className={styles.sourceLink} href={`/indexes/${index.id}`}>Open index page</Link></div>
  </section>;
}

export function TrackerCompare({ comparison, fmpIndexHref, fmpAvailable }: { comparison: Comparison; fmpIndexHref: string | null; fmpAvailable: boolean }) {
  return <section id="fmp-compare" className={styles.panel} aria-labelledby="compare-title">
    <div className={styles.sectionHead}>
      <div><h2 id="compare-title">Check against the FMP book</h2><p>Same bioguide ID, two dated sources side by side. Neither overwrites the other.</p></div>
      <span className={styles.badge}>{comparison.fmpPublished ? `FMP target · annual ${comparison.fmpPeriod}` : fmpAvailable ? "No FMP index published" : "Not in saved FMP directory"}</span>
    </div>
    <p className={styles.caption}>{comparison.note}</p>
    <TableRegion label="Tracker positions compared with the FMP published target">
      <table className={styles.table}>
        <thead><tr><th scope="col">Ticker</th><th scope="col">Presence</th><th scope="col" className={styles.number}>PelosiTracker % · {longDate(comparison.asOf)}</th><th scope="col" className={styles.number}>FMP target weight{comparison.fmpPeriod ? ` · ${comparison.fmpPeriod}` : ""}</th><th scope="col" className={styles.number}>FMP annual band</th></tr></thead>
        <tbody>{comparison.rows.map((row) => <tr key={row.ticker}>
          <td><strong>{row.ticker}</strong></td>
          <td><TrackerTag asOf={comparison.asOf} variant={row.presence === "both" ? "both" : row.presence === "tracker-only" ? "tracker" : "fmp"}>{row.presence === "both" ? "Both" : row.presence === "tracker-only" ? "Tracker only" : "FMP only"}</TrackerTag></td>
          <td className={styles.number}><strong>{row.trackerPercentage !== null ? pct(row.trackerPercentage) : "—"}</strong>{row.trackerValueUsd !== null && <small>{usd(row.trackerValueUsd)} tracker est.</small>}</td>
          <td className={styles.number}><strong>{row.fmpWeightBps !== null ? pct(row.fmpWeightBps / 100) : "—"}</strong></td>
          <td className={styles.number}><strong>{row.fmpAnnualBand ? disclosedRange(row.fmpAnnualBand) : "—"}</strong></td>
        </tr>)}</tbody>
      </table>
    </TableRegion>
    <div className={styles.panelFooter}><span>{comparison.overlap.tickers.length} on both · {comparison.overlap.trackerOnly.length} tracker only · {comparison.overlap.fmpOnly.length} FMP only</span>{fmpIndexHref && <Link className={styles.sourceLink} href={fmpIndexHref}>Open FMP published model</Link>}</div>
  </section>;
}

export function TrackerIdentity({ profile }: { profile: TrackerProfile }) {
  return <section className={styles.panel} aria-labelledby="tracker-identity-title">
    <div className={styles.sectionHead}><div><h2 id="tracker-identity-title">About this member</h2><p>Identity fields carried in the PelosiTracker handoff.</p></div><TrackerTag asOf={profile.asOf} /></div>
    <dl className={styles.statGrid}>
      <div><dt>Role</dt><dd style={{ fontSize: 15 }}>{profile.title ?? "—"}</dd><small>{[profile.party, profile.state, profile.district ? `District ${profile.district}` : null].filter(Boolean).join(" · ") || "—"}</small></div>
      <div><dt>Status</dt><dd style={{ fontSize: 15 }}>{profile.currentMember === null ? "—" : profile.currentMember ? "Current member" : "Former member"}</dd><small>{profile.yearsInCongress ?? "Tenure not given"}</small></div>
      <div><dt>Age</dt><dd style={{ fontSize: 15 }}>{profile.age ?? "—"}</dd><small>As published by the tracker</small></div>
      <div><dt>Tracker rank</dt><dd style={{ fontSize: 15 }}>#{profile.rank}</dd><small>Top 20 by PelosiTracker estimated portfolio value</small></div>
      <div><dt>Uninvested cash</dt><dd style={{ fontSize: 15 }}>{profile.portfolio.cashUsd !== null ? usdCompact(profile.portfolio.cashUsd) : "—"}</dd><small>Tracker estimate, not a balance</small></div>
    </dl>
    <p className={styles.caption} style={{ marginTop: 12 }}>{profile.bio ?? "No bio in the handoff."} {profile.committees.map((committee) => /^https:\/\//.test(committee) ? <a key={committee} className={styles.sourceLink} href={committee} target="_blank" rel="noreferrer">Official member record ↗</a> : <span key={committee}>{committee}</span>)}{profile.sourceUrl && <> · <a className={styles.sourceLink} href={profile.sourceUrl} target="_blank" rel="noreferrer">PelosiTracker page ↗</a></>}</p>
    {profile.news.length ? <details className={styles.coverage}><summary>In the news · {profile.news.length} headlines carried by PelosiTracker</summary>
      <ul className={styles.newsList}>{profile.news.map((item, i) => <li key={`${item.url ?? item.title}-${i}`}>{item.url ? <a href={item.url} target="_blank" rel="noreferrer">{item.title} ↗</a> : item.title}<small>{[item.source, item.date].filter(Boolean).join(" · ")}</small></li>)}</ul>
      <p>Third-party headlines as scraped; not InsiderIndex analysis.</p>
    </details> : null}
  </section>;
}

export function TrackerSourceStrip({ profile }: { profile: TrackerProfile }) {
  return <a className={styles.sourceStrip} href="#shown-book">
    <span className={styles.sourceIcon}><Icon name="shield" size={18} /></span>
    <span><strong>Where this page comes from</strong><small>PelosiTracker handoff scraped {longDate(profile.asOf)} (third-party model of the current book) → saved FMP annual disclosure (older filing) → InsiderIndex mint and Raydium-pool mapping. No live scrape; nothing is summed across sources.</small></span>
    <Icon name="arrow" size={16} />
  </a>;
}
