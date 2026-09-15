"use client";
import { useState } from "react";
import Link from "next/link";
import { useResource } from "@/lib/frontend/use-resource";
import { Skeleton } from "./social/shared";
import { PersonAvatar } from "./person-avatar";
import { Icon } from "./social/icon";
import { bookStatus, filterPeople, personContext } from "@/lib/frontend/disclosure-labels";
import type { StoredPerson } from "@/lib/fmp/store";
import styles from "./disclosure-workspace.module.css";

export type SavedDirectory = { people: StoredPerson[]; total: number; partial: boolean; savedAt: string | null; storage: string };
const PAGE_SIZE = 24;

export function IndexHome({ initialData }: { initialData?: SavedDirectory }) {
  const resource = useResource<SavedDirectory>("/api/people", initialData);
  const [query, setQuery] = useState("");
  const [chamber, setChamber] = useState("all");
  const [visible, setVisible] = useState(PAGE_SIZE);
  const [allIndexes, setAllIndexes] = useState(false);
  const directory = resource.data;
  const published = directory?.people.filter((person) => person.publishedIndexHash) ?? [];
  const people = filterPeople(directory?.people ?? [], query, chamber);

  return <div className={styles.workspace}>
    <section className={styles.invitation} aria-labelledby="welcome-title">
      <div className={styles.invitationCopy}>
        <span className={styles.kicker}>Public information. A different kind of access.</span>
        <h1 id="welcome-title">Everyone is<br />an insider.</h1>
        <p>Follow the filings. Explore the indexes. See what public figures disclose, without losing sight of the receipts.</p>
        <div className={styles.actions}>
          <Link className={styles.primaryButton} href="/feed">Copy one print <Icon name="bolt" size={17} /></Link>
          <a className={styles.quietButton} href="#published">Research indexes</a>
          <a className={styles.quietButton} href="#directory">Find a person</a>
        </div>
      </div>
      <div className={styles.passScene} aria-hidden="true">
        <div className={styles.insiderPass}>
          <div className={styles.passTop}><strong>stocklana.</strong><Icon name="landmark" size={26} /></div>
          <span className={styles.passLabel}>The public-information club</span>
          <div className={styles.passName}>Insider<br />access.</div>
          <div className={styles.passBottom}><span>Issued to<strong>You.</strong></span><span className={styles.passSeal}>Open<br />to everyone</span></div>
          <div className={styles.passStub}>No secret handshake required.<span>↗</span></div>
        </div>
      </div>
    </section>

    <div className={styles.sourceStrip}><span><Icon name="eye" size={16} /> Public disclosures, not live positions</span><span>Built for Solana</span></div>
    <section id="published" className={styles.section} aria-labelledby="indexes-title">
      <div className={styles.sectionHead}><div><h2 id="indexes-title">The index desk</h2><p>Saved annual holdings, turned into research target weights.</p></div>{directory && <span className={styles.count}>{published.length} published</span>}</div>
      <div className={styles.modelNote}><Icon name="shield" size={18} /><p><strong>Research first.</strong> These are published models, not live holdings or funded vaults. Buying is not available for these targets.</p></div>
      {!directory ? resource.error ? <div className={styles.empty} role="alert"><h3>The index desk couldn’t load.</h3><p>Saved disclosures are temporarily unavailable. Try loading them again.</p><button className={styles.secondaryButton} onClick={resource.reload}>Try again</button></div> : <Skeleton cards={2} /> : published.length ? <>
        <div className={styles.indexShelf}>{published.slice(0, allIndexes ? undefined : 6).map((person) => <article key={person.id} className={styles.indexTile}>
          <div className={styles.tileTop}><PersonAvatar name={person.name} imageUrl={person.image} size="lg" /><span className={styles.modelBadge}>Model index</span></div>
          <h3>{person.indexName ?? person.name}</h3><p className={styles.personMeta}>{person.name} · {personContext(person)}</p>
          <div className={styles.tileBottom}><Link className={styles.indexLink} href={`/indexes/fmp-${person.publishedIndexHash}`}>Research index <Icon name="arrow" size={17} /></Link><Link className={styles.bookLink} href={`/p/${person.id}`}>Disclosed book</Link></div>
        </article>)}</div>
        {published.length > 6 && <button className={styles.moreButton} aria-expanded={allIndexes} onClick={() => setAllIndexes(!allIndexes)}>{allIndexes ? "Show fewer indexes" : `See all ${published.length} indexes`} <Icon name={allIndexes ? "up" : "grid"} size={16} /></button>}
      </> : <div className={styles.empty}><h3>The next index starts with a filing.</h3><p>No targets have been published yet. You can still explore the saved disclosure books below.</p><a className={styles.secondaryButton} href="#directory">Browse people</a></div>}
    </section>

    <section id="directory" className={styles.section} aria-labelledby="directory-title">
      <div className={styles.sectionHead}><div><h2 id="directory-title">Names worth knowing</h2><p>The people behind the filings. Every disclosed asset stays in the book.</p></div>{directory && <span className={styles.count}>{directory.total} people</span>}</div>
      <div className={styles.directoryTools}>
        <label className={styles.search}><Icon name="search" size={19} /><span className="sr-only">Find a person by name, state, party or ID</span><input type="search" value={query} onChange={(event) => { setQuery(event.target.value); setVisible(PAGE_SIZE); }} placeholder="Search name, state, party…" />{query && <button aria-label="Clear person search" onClick={() => { setQuery(""); setVisible(PAGE_SIZE); }}><Icon name="close" size={16} /></button>}</label>
        <label className={styles.chamberFilter}><span className="sr-only">Filter by chamber</span><select value={chamber} onChange={(event) => { setChamber(event.target.value); setVisible(PAGE_SIZE); }}><option value="all">All chambers</option><option value="house">House</option><option value="senate">Senate</option></select></label>
      </div>
      {directory && <>
        <p className={styles.results} role="status">{people.length} {people.length === 1 ? "person" : "people"}{query.trim() ? ` matching “${query.trim()}”` : " in this view"}{directory.partial ? " · Directory coverage is partial" : ""}</p>
        <div className={styles.directoryList}>{people.slice(0, visible).map((person) => <Link className={styles.personRow} key={person.id} href={`/p/${person.id}`}>
          <PersonAvatar name={person.name} imageUrl={person.image} />
          <div className={styles.personName}><strong>{person.name}</strong><span>{personContext(person)}</span></div>
          <span className={styles.coverage}>{bookStatus(person.bookState)}</span>
          <span className={styles.rowEnd}>{person.publishedIndexHash && <span className={styles.indexIndicator}>Index</span>}<Icon name="arrow" size={18} /></span>
        </Link>)}</div>
        {!people.length && <div className={styles.empty}><h3>No matching people.</h3><p>Try a last name, a state abbreviation, or a different chamber.</p><button className={styles.secondaryButton} onClick={() => { setQuery(""); setChamber("all"); setVisible(PAGE_SIZE); }}>Reset filters</button></div>}
        {people.length > visible && <button className={styles.moreButton} onClick={() => setVisible(visible + PAGE_SIZE)}>Show {Math.min(PAGE_SIZE, people.length - visible)} more people <span>{visible} of {people.length}</span></button>}
        <p className={styles.finePrint}>Saved public disclosures via FMP{directory.savedAt ? ` · Updated ${new Date(directory.savedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })}` : " · Save date unavailable"}. Directory coverage does not mean every book is complete.</p>
      </>}
    </section>
    <section className={styles.feedBridge}><div><h2>More of a tape reader?</h2><p>Follow a filer or inspect one trade at a time.</p></div><Link className={styles.secondaryButton} href="/feed">Open disclosure feed <Icon name="bolt" size={17} /></Link></section>
  </div>;
}
