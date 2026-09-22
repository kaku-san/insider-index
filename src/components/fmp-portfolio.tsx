"use client";

import { useState } from "react";
import Link from "next/link";
import { useResource } from "@/lib/frontend/use-resource";
import { disclosedRange, personContext } from "@/lib/frontend/disclosure-labels";
import type { StoredPeopleService } from "@/lib/fmp/store";
import type { TrackerPersonView } from "@/lib/tracker/views";
import { buildShownBook, compareWithFmp, type FmpResolutionInput, type ShownBookToken } from "@/lib/tracker/shown-book";
import { noIndexReason, noIndexExplanation } from "@/lib/frontend/no-index-people";
import { Icon } from "./social/icon";
import { PageError, Skeleton } from "./social/shared";
import {
  AllocationPanel, FilingLink, PerformancePanel, PortfolioLayout,
  TableRegion, portfolioStyles as styles,
} from "./person-portfolio";
import {
  ShownBookPanel, TrackerCompare, TrackerFilingStats, TrackerHeroStats, TrackerIdentity,
  TrackerIndexPanel, TrackerLedger, TrackerSectors, TrackerSeries, TrackerSourceStrip, TrackerTag, TrackerTrades,
} from "./tracker-portfolio";

export type SavedPortfolio = Awaited<ReturnType<StoredPeopleService["portfolio"]>>;

/**
 * Honest, non-dead-end explanation for the ten politicians whose public disclosure
 * carries no mappable position book: no InsiderIndex person index exists, nothing is
 * invented, and the ten thematic research indexes fill the index lineup instead.
 */
function NoPersonIndexNotice({ id }: { id: string }) {
  const person = noIndexReason(id);
  if (!person) return null;
  return <div className={styles.notice} role="note">
    <Icon name="info" size={15} />
    <span><strong>No InsiderIndex person index.</strong> {noIndexExplanation(person)} Browse the <Link href="/#all-indexes-title">thematic research indexes</Link> instead.</span>
  </div>;
}
const savedDate = (value: string) => new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const estimate = (value: number) => value.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const eventSide = (value: string | null) => /purchase|buy/i.test(value ?? "") ? "buy" : /sale|sell/i.test(value ?? "") ? "sell" : "other";
const sortSnapshots = (snapshots: SavedPortfolio["snapshots"]) => [...snapshots].sort((a, b) => (b.year ?? 0) - (a.year ?? 0) || (b.filingDate ?? "").localeCompare(a.filingDate ?? "") || a.id.localeCompare(b.id));
/** Plain-English date for an annual reference: the filing is a year-end picture, not today's book. */
const annualLabel = (period: string | null | undefined) => period ? `annual disclosure as of ${new Date(`${period}T00:00:00Z`).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" })}` : "annual disclosure, reference date unknown";

/** Saved FMP sections: published target, allocation, disclosed book, trade history. Older annual disclosure, never a live book. */
function FmpSections({ book, snapshotId, setSnapshotId, olderLabel }: { book: SavedPortfolio; snapshotId: string | null; setSnapshotId: (value: string) => void; olderLabel: boolean }) {
  const snapshots = sortSnapshots(book.snapshots);
  const snapshot = snapshots.find((entry) => entry.id === snapshotId) ?? snapshots[0];
  const index = book.publishedIndex;
  const resolutions = new Map(index?.definition.evidence?.map((entry) => [entry.holding.id, entry]) ?? []);
  const activity = [...book.activity].sort((a, b) => (b.transactionDate ?? "").localeCompare(a.transactionDate ?? "") || (b.disclosureDate ?? "").localeCompare(a.disclosureDate ?? "") || a.id.localeCompare(b.id));
  const groupedActivity = activity.reduce((groups, trade) => {
    const key = trade.transactionDate ?? "Date unknown";
    groups.set(key, [...(groups.get(key) ?? []), trade]);
    return groups;
  }, new Map<string, typeof activity>());
  const indexHref = index ? `/indexes/fmp-${index.hash}` : undefined;
  const heading = olderLabel ? "Older annual disclosure · FMP" : "Current holdings · published index";

  return <>
    <section className={styles.panel} aria-labelledby="mapped-holdings-title">
      <div className={styles.sectionHead}>
        <div><h2 id="mapped-holdings-title">{heading}</h2><p>{index ? `Published FMP target from the ${annualLabel(index.period)}. ` : "No FMP target is published. "}{olderLabel ? "This is the latest annual filing we have, not 2026 holdings. " : ""}Changing the filing version below does not change this model.</p></div>
        <span className={styles.badge}>{index ? `${index.constituents.length} mapped names · annual ${index.period}` : "Not published"}</span>
      </div>
      {!index ? <div className={styles.empty}><h3>No mapped index is published</h3><p>The disclosed book is still available below. InsiderIndex does not invent a ticker, token, or weight when identity mapping is unresolved.</p></div> : <>
        <TableRegion label="Published index holdings and target weights">
          <table className={`${styles.table} ${styles.holdingsTable}`}>
            <thead><tr><th scope="col">Ticker</th><th scope="col">{index.definition.methodology === "holding-band-midpoints" ? "Value basis" : "Disclosure evidence"}</th><th scope="col" className={styles.number}>Target weight</th></tr></thead>
            <tbody>{index.constituents.map((item) => {
              const midpoint = item.payload?.evidencedMidpoint;
              const pct = item.weight_bps / 100;
              return <tr key={item.mint}>
                <td><div className={styles.tickerCell}><span className={styles.tickerMark}>{item.ticker.slice(0, 2)}</span><span><strong>{item.ticker}</strong><small>{item.issuer === "xstock" ? "xStock" : "Backpack"} mapped token</small></span></div></td>
                <td><strong>{midpoint != null ? estimate(midpoint) : "Normalized model"}</strong><small>{midpoint != null ? "Disclosure-band midpoint" : "No usable exact value band"}</small></td>
                <td className={styles.number}><strong>{pct.toFixed(2)}%</strong><div className={styles.weightTrack} aria-hidden="true"><span style={{ width: `${Math.min(100, pct)}%` }} /></div></td>
              </tr>;
            })}</tbody>
          </table>
        </TableRegion>
        <div className={styles.panelFooter}><span>Published {savedDate(index.published_at)} · model v{index.version}</span><Link className={styles.sourceLink} href={indexHref!}>View methodology &amp; mint addresses</Link></div>
      </>}
    </section>

    <AllocationPanel allocations={index?.constituents.map((item) => ({ ticker: item.ticker, weightBps: item.weight_bps }))}>
      {index && <div className={styles.allocationNote}>
        <strong>{index.definition.methodology === "holding-band-midpoints" ? "Weighted from disclosure bands" : "Equal-weight fallback"}</strong>
        <p>{index.definition.label} {index.definition.snapshotComplete ? "Complete annual source version." : "Partial annual source: mapped observed holdings only, not a verified complete portfolio."}</p>
        <Link className={styles.sourceLink} href={indexHref!}>Open published model</Link>
      </div>}
    </AllocationPanel>

    <section id="disclosed-book" className={styles.panel} aria-labelledby="holdings-title">
      <div className={styles.sectionHead}>
        <div><h2 id="holdings-title">Disclosed book · annual filing</h2><p>Every row in the selected annual source version{snapshot?.year ? ` (${annualLabel(`${snapshot.year}-12-31`)})` : ""}</p></div>
        <span className={styles.badge}>Public filing · not live holdings</span>
      </div>
      {!snapshot ? <div className={styles.empty}><h3>{book.state === "annual-source-unavailable" ? "Annual source unavailable" : "No annual book saved yet"}</h3><p>This does not mean the person owns nothing. Reported activity is shown below and is never used to manufacture a missing annual book.</p></div> : <>
        <div className={styles.selector}>
          <label htmlFor="filing-version">Filing version</label>
          <select id="filing-version" value={snapshot.id} onChange={(event) => setSnapshotId(event.target.value)}>
            {snapshots.map((entry) => <option key={entry.id} value={entry.id}>{entry.year ?? "Year unknown"} · filed {entry.filingDate ?? "date unknown"} · {entry.complete ? "Complete source" : "Partial / unreconciled"} · {entry.items.length} rows</option>)}
          </select>
          <FilingLink url={snapshot.sourceUrl} />
        </div>
        <p className={styles.caption}>{snapshot.year ? `Annual reference: ${snapshot.year}-12-31. ` : "Annual reference unknown. "}{snapshot.complete ? "Source ingestion complete; not independently verified." : "Partial / unreconciled source version; not a complete portfolio."}</p>
        <TableRegion label="Disclosed book; scroll for all columns">
          <table className={styles.table}>
            <thead><tr><th scope="col">Asset</th><th scope="col">Instrument</th><th scope="col" className={styles.number}>Disclosed value</th><th scope="col">InsiderIndex mapping</th></tr></thead>
            <tbody>{snapshot.items.map((item) => {
              const resolution = resolutions.get(item.id);
              const ticker = resolution?.ticker ?? item.ticker;
              const token = resolution ? resolution.token : item.token;
              return <tr key={item.id}>
                <td><strong>{ticker ?? item.name ?? "Unnamed disclosure"}</strong>{ticker && <small>{item.name}</small>}<small>{item.owner ?? "Owner not specified"}</small>
                  <details className={styles.rowDetails}><summary>Disclosure details</summary>
                    <p>{resolution ? `${resolution.method} · ${resolution.reason ?? "Mapped in published holdings target"}` : item.mappingReason ?? (item.token ? `${item.token.issuer} token available` : "Unresolved identity")}</p>
                    <p>Income range: {disclosedRange(item.incomeRange)}</p>
                    {item.providerValue != null && <p>Provider estimate: {estimate(item.providerValue)}. Not a market valuation.</p>}
                    {item.providerIncome != null && <p>Provider income estimate: {estimate(item.providerIncome)}</p>}
                    {item.comment && <p>{item.comment}</p>}
                  </details>
                </td>
                <td><span className={styles.instrument}>{item.kind}</span><small>{item.assetType ?? item.category ?? "Type not specified"}</small></td>
                <td className={styles.number}><strong>{disclosedRange(item.valueRange)}</strong></td>
                <td>{token ? <><strong>{token.issuer === "xstock" ? "xStock" : "Backpack"} · {token.symbol}</strong><small>Mapped Solana token</small></> : <><strong>Disclosed-only · no mapped Solana mint</strong><small>No approved Solana identity mapping</small></>}</td>
              </tr>;
            })}</tbody>
          </table>
        </TableRegion>
      </>}
      <details className={styles.coverage}><summary>Source coverage &amp; saved observation</summary>
        <p>{book.savedAt ? `Saved ${savedDate(book.savedAt)}.` : "Save date unavailable."} {snapshots.length} annual versions retained. Versions are selectable and are never added together.</p>
        {snapshot?.issues.length ? <p>{snapshot.issues.join(", ")}</p> : null}
        {book.ingestion && <ul>{Object.entries(book.ingestion).map(([name, source]) => <li key={name}>{name}: {source.status}, {source.count} retained rows{source.issues.length ? ` (${source.issues.map((issue) => issue.code).join(", ")})` : ""}</li>)}</ul>}
      </details>
    </section>

    <section className={styles.panel} aria-labelledby="activity-title">
      <div className={styles.sectionHead}>
        <div><h2 id="activity-title">{olderLabel ? "Saved FMP trade history" : "Allocation history / trades"}</h2><p>Reported activity grouped by transaction date</p></div>
        <span className={styles.badge}>{activity.length} saved trades</span>
      </div>
      <p className={styles.caption}>This is filing activity, not executed InsiderIndex rebalances. Buys and sales stay separate from the annual book. {book.activityComplete ? "History ingestion complete." : "History may be partial."}</p>
      {!activity.length ? <div className={styles.empty}><h3>No trade activity saved</h3><p>No saved transactions are available for this person. This is not evidence of no trading.</p></div> :
        <div className={styles.timeline}>{[...groupedActivity.entries()].map(([tradeDate, trades]) => <section className={styles.timelineGroup} key={tradeDate}>
          <div className={styles.timelineDate}><strong>{tradeDate === "Date unknown" ? tradeDate : savedDate(tradeDate)}</strong><span>{trades.length} {trades.length === 1 ? "change" : "changes"}</span></div>
          <div className={styles.timelineRows}>{trades.map((trade) => <article className={styles.timelineRow} key={trade.id}>
            <div className={styles.tradeMain}><span className={styles.event} data-side={eventSide(trade.event)}>{trade.event ?? "Not disclosed"}</span><div><strong>{trade.ticker ?? trade.name ?? "Unnamed disclosure"}</strong>{trade.ticker && <small>{trade.name}</small>}<small>{trade.kind} · {trade.owner ?? "Owner not specified"} · disclosed {trade.disclosureDate ?? "date unknown"}</small></div></div>
            <div className={styles.tradeAmount}><span>Amount range</span><strong>{disclosedRange(trade.amount)}</strong><FilingLink url={trade.sourceUrl} /></div>
          </article>)}</div>
        </section>)}</div>}
    </section>
  </>;
}

/** PelosiTracker-first page: tracker positions are the shown current book; FMP is the older annual disclosure beside it. */
function TrackerPerson({ id, tracker, resource }: { id: string; tracker: TrackerPersonView; resource: ReturnType<typeof useResource<SavedPortfolio>> }) {
  const [snapshotId, setSnapshotId] = useState<string | null>(null);
  const { profile } = tracker;
  const book = resource.data;
  const fmpMissing = Boolean(resource.error && !book);
  const snapshots = book ? sortSnapshots(book.snapshots) : [];
  const latest = snapshots[0] ?? null;
  const index = book?.publishedIndex ?? null;
  const resolutions = new Map<string, FmpResolutionInput>(index?.definition.evidence?.map((entry) => [entry.holding.id, entry]) ?? []);
  const tokens = new Map<string, ShownBookToken>(tracker.holdingTokens.flatMap((entry) => entry.token ? [[entry.ticker, { issuer: entry.token.issuer, symbol: entry.token.symbol, mint: entry.token.mint }]] : []));
  const annual = latest ? { referenceDate: latest.year ? `${latest.year}-12-31` : null, items: latest.items } : null;
  const shownBook = buildShownBook(profile, annual, resolutions, tokens);
  const comparison = compareWithFmp(profile, index ? { period: index.period, constituents: index.constituents } : null, annual, resolutions);
  const fmpIndexHref = index ? `/indexes/fmp-${index.hash}` : null;
  const context = [profile.chamber === "house" ? "House" : profile.chamber === "senate" ? "Senate" : "Chamber unknown", profile.state, profile.party].filter(Boolean).join(" · ");

  return <PortfolioLayout id={id} name={profile.name} indexName={tracker.index.indexName} image={profile.photo.local} context={context}
    strategy={profile.holdingsBasis === "copy-trade-full"
      ? `The shown book is PelosiTracker’s copy-trade portfolio (${profile.topHoldings.length} names, scraped ${savedDate(`${profile.asOf}T00:00:00Z`)}), a different product from the politician-API disclosure estimate. The FMP rows beside it are the older annual disclosure${annual?.referenceDate ? ` (as of ${annual.referenceDate})` : ""}. Trades are information only.`
      : `The shown book is PelosiTracker’s current positions (top ${profile.coverage.holdingsSlice} + OTHER, third-party model, scraped ${savedDate(`${profile.asOf}T00:00:00Z`)}). The FMP rows beside it are the older annual disclosure${annual?.referenceDate ? ` (as of ${annual.referenceDate})` : ""}. Trades are information only.`}
    count={profile.topHoldings.length} countNote={profile.holdingsBasis === "copy-trade-full" ? `PelosiTracker copy-trade book · ${profile.topHoldings.length} names` : `PelosiTracker top ${profile.coverage.holdingsSlice} + OTHER`}
    mappedCount={tracker.index.constituents.length} activityCount={profile.recentTrades.length}
    latestFiling={savedDate(`${profile.asOf}T00:00:00Z`)}
    indexHref={`/indexes/${tracker.index.id}`} indexLabel="Tracker index"
    heroStats={<TrackerHeroStats profile={profile} index={tracker.index} />}
    sourceStrip={<TrackerSourceStrip profile={profile} />}
    notice={<>
      <NoPersonIndexNotice id={id} />
      {resource.error && book ? <div className={styles.notice} role="alert">Could not refresh the saved FMP book. Showing the last loaded observation.<button onClick={resource.reload}>Retry</button></div> : null}
      {fmpMissing ? <div className={styles.notice} role="status"><TrackerTag asOf={profile.asOf} variant="fmp">FMP</TrackerTag>No saved FMP annual book for this person ({resource.error}). The PelosiTracker book below is complete on its own; no annual rows are invented.<button onClick={resource.reload}>Retry FMP</button></div> : null}
    </>}>

    <ShownBookPanel book={shownBook} view={tracker} fmpReferenceLabel={annual ? annualLabel(annual.referenceDate) : null} />
    <TrackerIndexPanel view={tracker} />
    <TrackerCompare comparison={comparison} fmpIndexHref={fmpIndexHref} fmpAvailable={Boolean(book)} />
    <TrackerSectors profile={profile} />
    <TrackerTrades profile={profile} />
    <TrackerLedger profile={profile} />
    <TrackerFilingStats profile={profile} />
    <TrackerSeries profile={profile} />
    <TrackerIdentity profile={profile} />
    {book ? <FmpSections book={book} snapshotId={snapshotId} setSnapshotId={setSnapshotId} olderLabel /> : !fmpMissing ? <Skeleton cards={2} /> : null}
  </PortfolioLayout>;
}

export function FmpPerson({ id, initialData, tracker }: { id: string; initialData?: SavedPortfolio; tracker?: TrackerPersonView | null }) {
  const resource = useResource<SavedPortfolio>(`/api/people/${encodeURIComponent(id)}/portfolio`, initialData);
  const [snapshotId, setSnapshotId] = useState<string | null>(null);
  if (tracker) return <TrackerPerson id={id} tracker={tracker} resource={resource} />;
  if (resource.error && !resource.data) return <PageError error={resource.error} retry={resource.reload} />;
  if (!resource.data) return <Skeleton cards={3} />;
  const book = resource.data;
  const snapshots = sortSnapshots(book.snapshots);
  const snapshot = snapshots.find((entry) => entry.id === snapshotId) ?? snapshots[0];
  const index = book.publishedIndex;
  const indexHref = index ? `/indexes/fmp-${index.hash}` : undefined;
  const latestFiling = snapshots.map((entry) => entry.filingDate).filter((date): date is string => Boolean(date)).sort().at(-1) ?? null;

  return <PortfolioLayout id={id} name={book.person.name} indexName={index ? book.indexName : undefined} image={book.person.image} context={personContext(book.person)}
    strategy={`Track the disclosed book (the latest annual filing we have${snapshot?.year ? `, as of ${snapshot.year}-12-31` : ""}), then inspect the mapped InsiderIndex separately. Reported trades remain activity—they never overwrite the annual filing.`}
    count={snapshot ? snapshot.items.length : null}
    countNote={snapshot ? `${snapshot.year ?? "Undated"} annual filing` : "Annual book unavailable"}
    mappedCount={index?.constituents.length ?? null}
    activityCount={book.activity.length}
    latestFiling={latestFiling ? savedDate(latestFiling) : null}
    indexHref={indexHref}
    notice={<>
      <NoPersonIndexNotice id={id} />
      {resource.error ? <div className={styles.notice} role="alert">Could not refresh this saved book. Showing the last loaded observation.<button onClick={resource.reload}>Retry</button></div> : null}
    </>}>
    <PerformancePanel />
    <FmpSections book={book} snapshotId={snapshotId} setSnapshotId={setSnapshotId} olderLabel={false} />
  </PortfolioLayout>;
}
