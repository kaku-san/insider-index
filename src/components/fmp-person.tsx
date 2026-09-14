"use client";
import Link from "next/link";
import { useResource } from "@/lib/frontend/use-resource";
import { PageError, Skeleton } from "./social/shared";
import { PersonAvatar } from "./person-avatar";
import { Icon } from "./social/icon";
import { disclosedRange, personContext } from "@/lib/frontend/disclosure-labels";
import type { StoredPeopleService, StoredPerson } from "@/lib/fmp/store";
import type { PublishedTradeIndex } from "@/lib/fmp/trade-index";
import styles from "./disclosure-workspace.module.css";

export { disclosedRange } from "@/lib/frontend/disclosure-labels";
type Portfolio = Awaited<ReturnType<StoredPeopleService["portfolio"]>>;
const date = (value: string) => new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

function SourceLink({ url }: { url: string | null }) {
  if (!url || !/^https?:\/\//i.test(url)) return <span className={styles.evidenceMeta}>Source link unavailable</span>;
  return <a href={url} target="_blank" rel="noreferrer" className={styles.sourceLink}>Source filing <span aria-hidden="true">↗</span></a>;
}

function InvestPanel() {
  return <aside id="invest" className={styles.investPanel} aria-labelledby="invest-title">
    <span className={styles.count}>Not open for investment</span>
    <h2 id="invest-title">One index. One token.</h2>
    <p>The intended investment flow is USDC into an index vault, in exchange for its share token.</p>
    <div className={styles.investPath}><span>USDC</span><Icon name="arrow" size={18} /><span>Index shares</span></div>
    <p id="invest-blocker"><strong>This is a research model.</strong> No live, execution-approved share-token vault is connected to this target. Deposits and signing are unavailable.</p>
    <button className={styles.secondaryButton} disabled aria-describedby="invest-blocker">Invest unavailable</button>
    <p className={styles.finePrint}>Connecting a wallet does not enable this model. No USDC is sent, no shares are issued, and no individual stock swaps are submitted.</p>
  </aside>;
}

export function PublishedTarget({ index }: { index: PublishedTradeIndex }) {
  return <section className={styles.targetPanel} aria-label="Published trade target">
    <span className={styles.modelBadge}>Published model · Not live holdings</span>
    <h2>Inside the index</h2><p>{index.definition.label}</p>
    <div className={styles.targetMeta}><span>Activity through {index.period}</span><span>Published {date(index.published_at)}</span><span>Version {index.version}</span></div>
    <div className={styles.modelNote}><Icon name="info" size={17} /><p>Weights reflect disclosed trade activity, including buys and sales—not current ownership. No live NAV or return is claimed.</p></div>
    <div className={styles.tableWrap} role="region" aria-label="Index target weights, scroll for mint addresses" tabIndex={0}>
      <table className={styles.table}><caption>{index.constituents.length} mapped names. Targets rounded to basis points.</caption><thead><tr><th scope="col">Asset</th><th scope="col">Target weight</th><th scope="col">Token issuer</th><th scope="col">Solana mint</th></tr></thead><tbody>{index.constituents.map((constituent) => <tr key={constituent.mint}><td><strong>{constituent.ticker}</strong></td><td className={styles.weight}>{(constituent.weight_bps / 100).toFixed(2)}%</td><td>{constituent.issuer}</td><td><code className={styles.mint}>{constituent.mint}</code></td></tr>)}</tbody></table>
    </div>
    <details className={styles.sourceDetails}><summary>How this target was built</summary><p>Activity-weighted, with at least one basis point per mapped name. Partial annual pages do not block publication; this target never repairs or replaces the annual book.</p><p>Excluded trade rows: {index.definition.excluded.length}</p><ul>{index.definition.excluded.map((excluded) => <li key={excluded.tradeId}>{excluded.ticker ?? excluded.name ?? "Unnamed disclosure"}: {excluded.reason}</li>)}</ul><p className={styles.targetVersion}>Immutable version: <code>{index.hash}</code></p></details>
  </section>;
}

export function FmpPerson({ id, initialData }: { id: string; initialData?: Portfolio }) {
  const resource = useResource<Portfolio>(`/api/people/${encodeURIComponent(id)}/portfolio`, initialData);
  if (resource.error && !resource.data) return <PageError error={resource.error} retry={resource.reload} />;
  if (!resource.data) return <Skeleton cards={3} />;
  const book = resource.data;
  return <div className={styles.workspace}>
    <Link className={styles.backLink} href="/#directory"><Icon name="arrow" size={16} style={{ transform: "rotate(180deg)" }} />People &amp; indexes</Link>
    <header className={styles.personHero}><PersonAvatar name={book.person.name} imageUrl={book.person.image} size="xl" /><div><span className={styles.kicker}>On the public record</span><h1>{book.person.name}</h1><p>{personContext(book.person)}</p><div className={styles.actions}><a className={styles.secondaryButton} href="#annual-book">Disclosed book</a>{book.publishedIndex && <a className={styles.quietButton} href="#trade-index">Published index</a>}<a className={styles.quietButton} href="#invest">Investment status</a></div></div></header>
    <div className={styles.coverageNote}><Icon name="file" size={21} /><div><strong>{book.state === "not-ingested" ? "This book hasn’t been saved yet." : book.bookComplete ? "Annual source ingestion complete." : "Partial disclosure. Not a complete portfolio."}</strong><p>These are dated disclosures, not live holdings. Different years and filing versions stay separate; they must not be added into a net-worth figure.</p><p>{book.savedAt ? `Saved ${date(book.savedAt)}.` : "Save date unavailable."} Every source row stays visible, whether or not it maps to a Solana token.</p>{book.ingestion && <details className={styles.sourceDetails}><summary>Check source coverage</summary><ul>{Object.entries(book.ingestion).map(([name, source]) => <li key={name}>{name}: {source.status}, {source.count} retained rows{source.issues.length ? ` (${source.issues.map((issue) => issue.code).join(", ")})` : ""}</li>)}</ul></details>}</div></div>

    <section id="annual-book" className={styles.section} aria-labelledby="annual-title"><div className={styles.sectionHead}><div><h2 id="annual-title">The disclosed book</h2><p>Original annual filings. All assets, not just tradable stocks.</p></div><span className={styles.count}>{book.snapshots.length} versions</span></div>
      {!book.snapshots.length && <div className={styles.empty}><h3>No annual book saved yet.</h3><p>This does not mean the person owns nothing. Trade activity, if available, is listed separately below.</p></div>}
      {book.snapshots.map((snapshot, i) => <details className={styles.evidenceDetails} key={snapshot.id} open={i === 0}><summary><strong>{snapshot.year ?? "Year unknown"}</strong><span>Filed {snapshot.filingDate ?? "date unknown"} · {snapshot.items.length} rows · {snapshot.complete ? "Complete source version" : "Partial / unreconciled"}</span></summary><p className={styles.evidenceMeta}><SourceLink url={snapshot.sourceUrl} />{snapshot.issues.length ? ` · ${snapshot.issues.join(", ")}` : ""}</p><div className={styles.tableWrap} role="region" aria-label={`${snapshot.year ?? "Unknown year"} disclosed book, scroll for all columns`} tabIndex={0}><table className={styles.table}><thead><tr><th scope="col">Disclosed asset</th><th scope="col">Type / owner</th><th scope="col">Value range</th><th scope="col">Income range</th><th scope="col">Index mapping</th></tr></thead><tbody>{snapshot.items.map((item) => <tr key={item.id}><td><strong>{item.name ?? "Unnamed disclosure"}</strong>{item.ticker && <small>{item.ticker}</small>}</td><td>{item.kind}<small>{item.owner ?? "Owner not specified"}</small></td><td>{disclosedRange(item.valueRange)}</td><td>{disclosedRange(item.incomeRange)}</td><td>{item.mappingReason ?? (item.token ? `${item.token.issuer} available; annual row not used in trade target` : "Unresolved symbol")}</td></tr>)}</tbody></table></div></details>)}
    </section>

    <section id="trade-index" className={styles.section} aria-labelledby="target-title"><div className={styles.sectionHead}><div><h2 id="target-title">From activity to index</h2><p>A separate model, not a reconstruction of the book above.</p></div></div><div className={styles.indexLayout}><div>{book.publishedIndex ? <><PublishedTarget index={book.publishedIndex} /><Link className={styles.sourceLink} href={`/indexes/fmp-${book.publishedIndex.hash}`}>Open this index’s permanent page</Link></> : <div className={styles.empty}><h3>No published index yet.</h3><p>A disclosed book is not automatically an index. You can still inspect the original filings and trade activity.</p></div>}</div><InvestPanel /></div></section>

    <section className={styles.section} aria-labelledby="activity-title"><div className={styles.sectionHead}><div><h2 id="activity-title">The trade record</h2><p>{book.activityComplete ? "History ingestion complete" : "History may be partial"}. Buys and sales are activity, not remaining balances.</p></div><span className={styles.count}>{book.activity.length} rows</span></div>{!book.activity.length ? <div className={styles.empty}><h3>No trade activity saved.</h3><p>There are no saved trade rows to display for this person.</p></div> : <div className={styles.tableWrap} role="region" aria-label="Disclosed trade activity, scroll for all columns" tabIndex={0}><table className={styles.table}><thead><tr><th scope="col">Trade / disclosed</th><th scope="col">Asset</th><th scope="col">Event / owner</th><th scope="col">Amount range</th><th scope="col">Mapping / source</th></tr></thead><tbody>{book.activity.map((trade) => <tr key={trade.id}><td>{trade.transactionDate ?? "Unknown"}<small>Disclosed {trade.disclosureDate ?? "date unknown"}</small></td><td><strong>{trade.ticker ?? "No symbol"}</strong><small>{trade.name}</small></td><td>{trade.event ?? "Not disclosed"}<small>{trade.owner ?? "Owner not specified"}</small></td><td>{disclosedRange(trade.amount)}</td><td>{trade.mappingReason ?? trade.token?.issuer ?? "Unmapped"}<br /><SourceLink url={trade.sourceUrl} /></td></tr>)}</tbody></table></div>}</section>
  </div>;
}

export function FmpIndex({ hash, initialData }: { hash: string; initialData?: { index: PublishedTradeIndex } }) {
  const resource = useResource<{ index: PublishedTradeIndex }>(`/api/published-indexes/${encodeURIComponent(hash)}`, initialData);
  const directory = useResource<{ people: StoredPerson[] }>("/api/people");
  if (resource.error && !resource.data) return <PageError error={resource.error} retry={resource.reload} />;
  if (!resource.data) return <Skeleton cards={2} />;
  const { index } = resource.data;
  const person = directory.data?.people.find((entry) => entry.id === index.person_id);
  return <div className={styles.workspace}><Link className={styles.backLink} href={`/p/${index.person_id}`}><Icon name="arrow" size={16} style={{ transform: "rotate(180deg)" }} />Original book &amp; activity</Link><header className={styles.indexHero}><span className={styles.kicker}>The index desk</span><h1>{person ? `${person.name} index` : "Published trade index"}</h1><p>See the weights. Check the sources. Know what you’re looking at.</p></header><div className={styles.indexLayout}><PublishedTarget index={index} /><InvestPanel /></div></div>;
}
