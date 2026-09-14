"use client";
import Link from "next/link";
import { useResource } from "@/lib/frontend/use-resource";
import { PageError, Skeleton } from "./social/shared";
import type { StoredPeopleService } from "@/lib/fmp/store";
import type { Band } from "@/lib/fmp/types";
import type { PublishedTradeIndex } from "@/lib/fmp/trade-index";

type Portfolio = Awaited<ReturnType<StoredPeopleService["portfolio"]>>;
export function disclosedRange({ low, high }: Band) {
  const usd = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
  if (low === null && high === null) return "Not disclosed";
  if (low === null) return `Up to ${usd(high!)}`;
  if (high === null) return `${usd(low)}+`;
  return low === high ? usd(low) : `${usd(low)}–${usd(high)}`;
}
function SourceLink({ url }: { url: string | null }) {
  // Source text is untrusted; only web links are navigable.
  if (!url || !/^https?:\/\//i.test(url)) return <span>Source link unavailable</span>;
  return <a href={url} target="_blank" rel="noreferrer" className="text-button">Source filing ↗</a>;
}
export function PublishedTarget({ index }: { index: PublishedTradeIndex }) {
  return <section className="panel fmp-panel"><span className="eyebrow">PUBLISHED TRADE INDEX · MODEL TARGET ONLY</span><h2>Target weights</h2><p>{index.definition.label}</p><p className="muted">Trade activity through {index.period} · Published {new Date(index.published_at).toLocaleDateString()} · Version {index.version}. Rounded to basis points, minimum one basis point per mapped name.</p><p>Annual pagination may be partial. This target does not repair or replace the annual book. No live vault NAV, return, or net-worth point is claimed. This is not an execution-approved basket.</p>
    <div className="fmp-table-wrap"><table className="fmp-table"><thead><tr><th>Symbol</th><th>Target</th><th>Issuer</th><th>Solana mint</th></tr></thead><tbody>{index.constituents.map((c) => <tr key={c.mint}><td>{c.ticker}</td><td>{(c.weight_bps / 100).toFixed(2)}%</td><td>{c.issuer}</td><td className="fmp-mint">{c.mint}</td></tr>)}</tbody></table></div>
    <details><summary>Excluded trade rows ({index.definition.excluded.length})</summary><ul>{index.definition.excluded.map((e) => <li key={e.tradeId}>{e.ticker ?? e.name ?? "Unnamed disclosure"}: {e.reason}</li>)}</ul></details>
    <p className="fmp-mint muted">Immutable version: {index.hash}</p>
  </section>;
}
export function FmpPerson({ id, initialData }: { id: string; initialData?: Portfolio }) {
  const resource = useResource<Portfolio>(`/api/people/${encodeURIComponent(id)}/portfolio`, initialData);
  if (resource.error) return <PageError error={resource.error} retry={resource.reload} />;
  if (!resource.data) return <Skeleton cards={3} />;
  const book = resource.data;
  return <div className="index-home"><Link className="text-button" href="/">← All people &amp; indexes</Link><div className="page-intro"><div><span className="eyebrow">SAVED FMP DISCLOSURES</span><h1>{book.person.name}</h1><p>{book.person.chamber} · {book.person.party ?? "Party unavailable"} · {book.person.state ?? "State unavailable"}</p></div></div>
    <div className="panel fmp-panel"><strong>{book.state === "not-ingested" ? "Book not yet downloaded" : book.bookComplete ? "Annual source ingestion complete" : "Partial annual disclosure — not a complete book"}</strong><p>Saved {book.savedAt ? new Date(book.savedAt).toLocaleString() : "time unavailable"}. Original disclosed rows and nullable dollar bands are preserved. Years and document versions are separate; never add them into a current net-worth figure.</p>{book.ingestion && <details><summary>Source coverage</summary><ul>{Object.entries(book.ingestion).map(([name, source]) => <li key={name}>{name}: {source.status}, {source.count} retained rows{source.issues.length ? ` (${source.issues.map((i) => i.code).join(", ")})` : ""}</li>)}</ul></details>}</div>
    {book.publishedIndex ? <><PublishedTarget index={book.publishedIndex} /><p><Link className="text-button" href={`/indexes/fmp-${book.publishedIndex.hash}`}>Permalink to this target →</Link></p></> : <section className="panel fmp-panel"><h2>No published trade target yet</h2><p>A saved book is not automatically an index. The original rows remain visible below.</p></section>}
    <section className="home-section"><h2>Full disclosed annual book</h2>{!book.snapshots.length && <p>No annual rows have been saved for this person.</p>}{book.snapshots.map((snapshot, i) => <details className="panel fmp-panel" key={snapshot.id} open={i === 0}><summary><strong>{snapshot.year ?? "Year unknown"} · Filed {snapshot.filingDate ?? "date unknown"} · {snapshot.items.length} rows · {snapshot.complete ? "Complete source version" : "Partial / unreconciled"}</strong></summary><p><SourceLink url={snapshot.sourceUrl} /> · {snapshot.issues.join(", ")}</p><div className="fmp-table-wrap"><table className="fmp-table"><thead><tr><th>Disclosed name</th><th>Type / owner</th><th>Disclosed value range</th><th>Income range</th><th>Index mapping</th></tr></thead><tbody>{snapshot.items.map((item) => <tr key={item.id}><td>{item.name ?? "Unnamed disclosure"}{item.ticker ? ` (${item.ticker})` : ""}</td><td>{item.kind}<br />{item.owner ?? "Owner not specified"}</td><td>{disclosedRange(item.valueRange)}</td><td>{disclosedRange(item.incomeRange)}</td><td>{item.mappingReason ?? (item.token ? `${item.token.issuer} available; annual row not used in trade target` : "Unresolved symbol")}</td></tr>)}</tbody></table></div></details>)}</section>
    <section className="home-section"><h2>Disclosed trade activity</h2><p>{book.activityComplete ? "History ingestion complete" : "History may be partial"}. Buys and sales stay activity, not remaining balances.</p>{!book.activity.length ? <p>No trade activity has been saved.</p> : <div className="fmp-table-wrap"><table className="fmp-table"><thead><tr><th>Trade / disclosed</th><th>Symbol / name</th><th>Event / owner</th><th>Amount</th><th>Mapping / source</th></tr></thead><tbody>{book.activity.map((trade) => <tr key={trade.id}><td>{trade.transactionDate ?? "Unknown"}<br />{trade.disclosureDate ?? "Unknown"}</td><td>{trade.ticker ?? "No symbol"}<br />{trade.name}</td><td>{trade.event ?? "Not disclosed"}<br />{trade.owner ?? "Owner not specified"}</td><td>{disclosedRange(trade.amount)}</td><td>{trade.mappingReason ?? trade.token?.issuer ?? "Unmapped"}<br /><SourceLink url={trade.sourceUrl} /></td></tr>)}</tbody></table></div>}</section>
  </div>;
}
export function FmpIndex({ hash, initialData }: { hash: string; initialData?: { index: PublishedTradeIndex } }) {
  const resource = useResource<{ index: PublishedTradeIndex }>(`/api/published-indexes/${encodeURIComponent(hash)}`, initialData);
  if (resource.error) return <PageError error={resource.error} retry={resource.reload} />;
  if (!resource.data) return <Skeleton cards={2} />;
  const { index } = resource.data;
  return <div className="index-home"><Link className="text-button" href={`/p/${index.person_id}`}>← Person’s original book &amp; activity</Link><h1>Published trade index</h1><PublishedTarget index={index} /></div>;
}
