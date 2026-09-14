"use client";

import { useState } from "react";
import Link from "next/link";
import { useResource } from "@/lib/frontend/use-resource";
import { disclosedRange, personContext } from "@/lib/frontend/disclosure-labels";
import type { StoredPeopleService } from "@/lib/fmp/store";
import { PageError, Skeleton } from "./social/shared";
import {
  AllocationPanel, FilingLink, MissingValue, PerformancePanel, PortfolioLayout,
  TableRegion, portfolioStyles as styles,
} from "./person-portfolio";

export type SavedPortfolio = Awaited<ReturnType<StoredPeopleService["portfolio"]>>;
const savedDate = (value: string) => new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const estimate = (value: number) => value.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

export function FmpPerson({ id, initialData }: { id: string; initialData?: SavedPortfolio }) {
  const resource = useResource<SavedPortfolio>(`/api/people/${encodeURIComponent(id)}/portfolio`, initialData);
  const [snapshotId, setSnapshotId] = useState<string | null>(null);
  if (resource.error && !resource.data) return <PageError error={resource.error} retry={resource.reload} />;
  if (!resource.data) return <Skeleton cards={3} />;
  const book = resource.data;
  // Select a source version, never combine years or promote a partial book to complete.
  const snapshots = [...book.snapshots].sort((a, b) => (b.year ?? 0) - (a.year ?? 0) || (b.filingDate ?? "").localeCompare(a.filingDate ?? "") || a.id.localeCompare(b.id));
  const snapshot = snapshots.find((entry) => entry.id === snapshotId) ?? snapshots[0];
  const index = book.publishedIndex;
  const activity = [...book.activity].sort((a, b) => (b.transactionDate ?? "").localeCompare(a.transactionDate ?? "") || (b.disclosureDate ?? "").localeCompare(a.disclosureDate ?? "") || a.id.localeCompare(b.id));

  return <PortfolioLayout id={id} name={book.person.name} indexName={index ? book.indexName : undefined} image={book.person.image} context={personContext(book.person)}
    strategy="Follow the disclosed book and explore an index built from publicly reported trade activity."
    count={snapshot ? snapshot.items.length : null}
    countNote={snapshot ? `${snapshot.year ?? "Undated"} filing · all asset types, not live holdings` : "Annual book not available"}
    notice={resource.error ? <div className={styles.notice} role="alert">Could not refresh this saved book. Showing the last loaded observation.<button onClick={resource.reload}>Retry</button></div> : undefined}>
    <PerformancePanel />

    <section className={styles.panel} aria-labelledby="holdings-title">
      <div className={styles.sectionHead}><h2 id="holdings-title">Current holdings</h2><span className={styles.badge}>Disclosed book · not live</span></div>
      <p className={styles.caption}>The latest saved annual disclosure, not a brokerage balance. All assets remain here, including unresolved names and assets without a Solana token.</p>
      {!snapshot ? <div className={styles.empty}><h3>{book.state === "annual-source-unavailable" ? "Annual source unavailable" : "No annual book saved yet"}</h3><p>This does not mean the person owns nothing. Available trade activity is shown below; it cannot fill in a missing annual book.</p></div> : <>
        <div className={styles.selector}>
          <label htmlFor="filing-version">Filing version</label>
          <select id="filing-version" value={snapshot.id} onChange={(event) => setSnapshotId(event.target.value)}>
            {snapshots.map((entry) => <option key={entry.id} value={entry.id}>{entry.year ?? "Year unknown"} · filed {entry.filingDate ?? "date unknown"} · {entry.complete ? "Complete source" : "Partial / unreconciled"} · {entry.items.length} rows</option>)}
          </select>
        </div>
        <p className={styles.caption}>{snapshot.year ? `Annual reference: ${snapshot.year}-12-31. ` : "Annual reference unknown. "}{snapshot.complete ? "Source ingestion complete; not independently verified." : "Partial / unreconciled source version; not a complete portfolio."} <FilingLink url={snapshot.sourceUrl} /></p>
        <TableRegion label="Disclosed holdings; scroll for all columns">
          <table className={styles.table}>
            <thead><tr><th scope="col">Disclosed asset / ticker</th><th scope="col" className={styles.number}>Last price</th><th scope="col" className={styles.number}>Disclosed value</th><th scope="col" className={styles.number}>Weight</th></tr></thead>
            <tbody>{snapshot.items.map((item) => <tr key={item.id}>
              <td><strong>{item.ticker ?? item.name ?? "Unnamed disclosure"}</strong>{item.ticker && <small>{item.name}</small>}<small>{item.kind} · {item.owner ?? "Owner not specified"}</small>
                <details className={styles.rowDetails}><summary>Disclosure details</summary>
                  <p>{item.mappingReason ?? (item.token ? `${item.token.issuer} token available; annual row is not a trade target` : "Unresolved symbol")}</p>
                  <p>Income range: {disclosedRange(item.incomeRange)}</p>
                  {item.providerValue != null && <p>Provider value estimate: {estimate(item.providerValue)}. Not a market valuation.</p>}
                  {item.providerIncome != null && <p>Provider income estimate: {estimate(item.providerIncome)}</p>}
                  {item.comment && <p>{item.comment}</p>}
                </details>
              </td>
              <td className={styles.number}><MissingValue /></td>
              <td className={styles.number}>{disclosedRange(item.valueRange)}</td>
              <td className={styles.number}><MissingValue /></td>
            </tr>)}</tbody>
          </table>
        </TableRegion>
        <p className={styles.caption}>Last prices are unavailable. Disclosed dollar bands are not exact portfolio weights; published index weights, when available, are shown separately below.</p>
      </>}
      <details className={styles.coverage}><summary>Source coverage &amp; saved observation</summary>
        <p>{book.savedAt ? `Saved ${savedDate(book.savedAt)}.` : "Save date unavailable."} {snapshots.length} annual versions retained. Select a filing version above to inspect it; versions are never added together.</p>
        {snapshot?.issues.length ? <p>{snapshot.issues.join(", ")}</p> : null}
        {book.ingestion && <ul>{Object.entries(book.ingestion).map(([name, source]) => <li key={name}>{name}: {source.status}, {source.count} retained rows{source.issues.length ? ` (${source.issues.map((issue) => issue.code).join(", ")})` : ""}</li>)}</ul>}
      </details>
    </section>

    <AllocationPanel allocations={index?.constituents.map((item) => ({ ticker: item.ticker, weightBps: item.weight_bps }))}>
      {index && <>
        <div className={styles.sectionHead}><h3>{book.indexName ?? "Published index"} constituents</h3><span className={styles.badge}>Version {index.version}</span></div>
        <p className={styles.caption}>{index.definition.label} Activity through {index.period}; published {savedDate(index.published_at)}.</p>
        <TableRegion label="Published index weights">
          <table className={styles.table}><thead><tr><th scope="col">Ticker</th><th scope="col" className={styles.number}>Last price</th><th scope="col" className={styles.number}>Target weight</th></tr></thead><tbody>
            {index.constituents.map((item) => <tr key={item.mint}><td><strong>{item.ticker}</strong><small>{item.issuer}</small></td><td className={styles.number}><MissingValue /></td><td className={styles.number}>{(item.weight_bps / 100).toFixed(2)}%</td></tr>)}
          </tbody></table>
        </TableRegion>
        <Link className={styles.sourceLink} href={`/indexes/fmp-${index.hash}`}>View published version &amp; methodology</Link>
      </>}
    </AllocationPanel>

    <section className={styles.panel} aria-labelledby="activity-title">
      <div className={styles.sectionHead}><h2 id="activity-title">Allocation history / trades</h2><span className={styles.badge}>{activity.length} saved trades</span></div>
      <p className={styles.caption}>Reported FMP activity, not executed vault rebalances. Buys and sales do not rewrite the annual book. {book.activityComplete ? "History ingestion complete." : "History may be partial."}</p>
      {!activity.length ? <div className={styles.empty}><h3>No trade activity saved</h3><p>No saved transactions are available for this person. This is not evidence of no trading.</p></div> :
        <TableRegion label="Reported trades; scroll for dates and ranges">
          <table className={styles.table}>
            <thead><tr><th scope="col">Trade date</th><th scope="col">Asset</th><th scope="col">Activity</th><th scope="col" className={styles.number}>Amount range</th></tr></thead>
            <tbody>{activity.map((trade) => <tr key={trade.id}>
              <td>{trade.transactionDate ?? "Date unknown"}<small>Disclosed {trade.disclosureDate ?? "date unknown"}</small><FilingLink url={trade.sourceUrl} /></td>
              <td><strong>{trade.ticker ?? trade.name ?? "Unnamed disclosure"}</strong>{trade.ticker && <small>{trade.name}</small>}<small>{trade.kind}</small></td>
              <td><span className={styles.event} data-side={/purchase|buy/i.test(trade.event ?? "") ? "buy" : /sale|sell/i.test(trade.event ?? "") ? "sell" : "other"}>{trade.event ?? "Not disclosed"}</span><small>{trade.owner ?? "Owner not specified"}</small></td>
              <td className={styles.number}>{disclosedRange(trade.amount)}</td>
            </tr>)}</tbody>
          </table>
        </TableRegion>}
    </section>
  </PortfolioLayout>;
}
