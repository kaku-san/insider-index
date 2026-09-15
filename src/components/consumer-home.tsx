"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useResource } from "@/lib/frontend/use-resource";
import { Icon } from "./social/icon";
import { portraitFor } from "@/lib/fomo/portraits";
import { slugifyPerson, personContext, shortDate } from "@/lib/frontend/research-format";
import type { PeopleDirectoryResponse, PublishedIndexResponse, ResearchPerson } from "@/lib/frontend/research-contract";
import type { TrackerListResponse } from "@/lib/tracker/types";
import type { CopySignal, FomoProfile } from "@/lib/disclosures/types";
import { useUI } from "./providers/ui-provider";
import { PageError } from "./social/shared";
import styles from "./consumer-home.module.css";

type LegacyProfiles = { profiles: FomoProfile[] };
type DisclosureResponse = { disclosures?: CopySignal[]; signals?: CopySignal[]; source?: string };

function normalizedPeople(directory?: PeopleDirectoryResponse, legacy?: LegacyProfiles): ResearchPerson[] {
  if (directory?.people?.length) return directory.people;
  return (legacy?.profiles ?? []).map((profile) => ({
    id: profile.id,
    name: profile.name,
    office: profile.title,
    party: profile.party,
    state: profile.state,
    chamber: profile.chamber,
    image: profile.imageUrl,
    publishedIndexHash: null,
    indexName: profile.index?.name ?? null,
    bookState: "legacy-disclosure-book",
  }));
}

function imageFor(person?: ResearchPerson | null) {
  if (!person) return null;
  return person.image ?? portraitFor(slugifyPerson(person.name));
}

function displayIndexName(person: ResearchPerson) {
  if (person.indexName) return person.indexName;
  const parts = person.name.trim().split(/\s+/);
  return `${parts[0]} ${parts.at(-1)?.[0] ?? ""} Index`;
}

function PublishedMeta({ hash, compact = false }: { hash: string; compact?: boolean }) {
  const result = useResource<PublishedIndexResponse>(`/api/published-indexes/${encodeURIComponent(hash)}`);
  if (!result.data) return <span>{compact ? "Published model" : "Published from public filings"}</span>;
  const index = result.data.index;
  const period = index.period ? shortDate(index.period) : "saved model";
  return <span>{index.constituents.length} mapped names · {period}</span>;
}

function Portrait({ person, className }: { person: ResearchPerson; className?: string }) {
  const src = imageFor(person);
  const [failed, setFailed] = useState(false);
  return <div className={`${styles.portrait} ${className ?? ""}`}>{src && !failed ? <img src={src} alt={person.name} onError={() => setFailed(true)} /> : <span>{person.name.split(" ").map((word) => word[0]).join("").slice(0, 2)}</span>}</div>;
}

function FollowButton({ person }: { person: ResearchPerson }) {
  const ui = useUI();
  const following = ui.deviceFollows.includes(person.id);
  return <button type="button" className={`${styles.followButton} ${following ? styles.isFollowing : ""}`} aria-pressed={following} onClick={(event) => { event.preventDefault(); ui.toggleDeviceFollow(person.id); }}>
    <Icon name={following ? "check" : "people"} size={14} />{following ? "Following" : "Follow"}
  </button>;
}

function PersonCover({ person, featured = false }: { person: ResearchPerson; featured?: boolean }) {
  const indexName = displayIndexName(person);
  return <article className={`${styles.coverCard} ${featured ? styles.featuredCover : ""}`}>
    <Link href={`/p/${encodeURIComponent(person.id)}`} className={styles.coverImage} aria-label={`Open ${person.name}`}>
      <Portrait person={person} />
      <span className={styles.coverBadge}>{person.publishedIndexHash ? "PERSON INDEX" : "ON THE RADAR"}</span>
      <span className={styles.coverArrow}><Icon name="arrow" size={18} /></span>
    </Link>
    <div className={styles.coverBody}>
      <p>{personContext(person)}</p>
      <h3>{person.publishedIndexHash ? indexName : person.name}</h3>
      <div className={styles.coverMeta}>{person.publishedIndexHash ? <PublishedMeta hash={person.publishedIndexHash} compact /> : person.indexName ? <span>{person.bookState ? person.bookState.replaceAll("-", " ") : "Public disclosure model"}</span> : <span>Public disclosure profile</span>}</div>
      <div className={styles.coverActions}><FollowButton person={person} /><Link href={`/p/${encodeURIComponent(person.id)}`}>Open portfolio</Link></div>
    </div>
  </article>;
}

export function FilingTape({ disclosures, error, loading = false, retry }: { disclosures: CopySignal[]; error: string | null; loading?: boolean; retry: () => void }) {
  const rows = disclosures.slice(0, 5);
  if (error && !rows.length) return <PageError error={error} retry={retry}/>;
  if (loading && !rows.length) return <div className={styles.tapeLoading} aria-busy="true" aria-label="Loading recent disclosures"><i/><i/><i/></div>;
  if (!rows.length) return <div className={styles.tapeEmpty}><strong>Nothing new on the tape.</strong><span>Fresh sourced disclosures appear here when the feed is connected.</span></div>;
  return <div className={styles.tape}>{rows.map((row, index) => <Link href={row.tradeEligible ? `/trade/${encodeURIComponent(row.id)}?copy=1` : `/disclosures/${encodeURIComponent(row.id)}`} className={styles.tapeRow} key={row.id}>
    <span className={styles.tapeIndex}>{String(index + 1).padStart(2, "0")}</span>
    <span className={`${styles.tapeSide} ${row.side === "buy" ? styles.buy : row.side === "sell" ? styles.sell : ""}`}>{row.side === "buy" ? "BOUGHT" : row.side === "sell" ? "SOLD" : "FILED"}</span>
    <div><strong>{row.insiderName}</strong><small>{row.ticker} · {row.issuerName}</small></div>
    <span className={styles.tapeDate}>{shortDate(row.transactionDate)}</span>
    <span className={styles.tapeCta}>{row.tradeEligible ? "Copy" : "View"} <Icon name="arrow" size={13} /></span>
  </Link>)}</div>;
}

export function ConsumerHome({ initialData }: { initialData?: PeopleDirectoryResponse }) {
  const params = useSearchParams();
  const urlQuery = params.get("q") ?? "";
  const [queryDraft, setQueryDraft] = useState({ urlQuery, value: urlQuery });
  const localQuery = queryDraft.urlQuery === urlQuery ? queryDraft.value : urlQuery;
  const setLocalQuery = (value: string) => setQueryDraft({ urlQuery, value });
  const [visible, setVisible] = useState(10);
  const peopleResult = useResource<PeopleDirectoryResponse>("/api/people", initialData);
  const trackerResult = useResource<TrackerListResponse>("/api/tracker-profiles");
  const primaryHasPeople = Boolean(peopleResult.data?.people?.length || trackerResult.data?.people?.length);
  const legacyNeeded = !peopleResult.loading && !trackerResult.loading && !primaryHasPeople;
  const legacyResult = useResource<LegacyProfiles>(legacyNeeded ? "/api/profiles" : null);
  const disclosureResult = useResource<DisclosureResponse>("/api/disclosures");
  const people = useMemo(() => {
    const tracked = (trackerResult.data?.people ?? []).map((person) => ({
      id: person.id,
      name: person.name,
      office: person.title,
      party: person.party,
      state: person.state,
      chamber: person.chamber,
      image: person.image,
      publishedIndexHash: null,
      indexName: null,
      bookState: "tracker-current-book",
    } satisfies ResearchPerson));
    const rest = normalizedPeople(peopleResult.data ?? undefined, legacyResult.data ?? undefined);
    const enriched = tracked.map((person) => {
      const match = rest.find((row) => row.id === person.id || row.name === person.name);
      return match ? { ...person, publishedIndexHash: match.publishedIndexHash, indexName: match.indexName, image: person.image ?? match.image } : person;
    });
    const leftover = rest.filter((person) => !enriched.some((row) => row.id === person.id || row.name === person.name));
    return [...enriched, ...leftover];
  }, [peopleResult.data, legacyResult.data, trackerResult.data]);
  const disclosures = disclosureResult.data?.disclosures ?? disclosureResult.data?.signals ?? [];
  const directoryError = !people.length && !peopleResult.loading && !trackerResult.loading && !legacyResult.loading
    ? [trackerResult.error, peopleResult.error, legacyResult.error].filter((error, index, errors): error is string => Boolean(error) && errors.indexOf(error) === index).join(" ") || null
    : null;
  const retryDirectory = () => { trackerResult.reload(); peopleResult.reload(); legacyResult.reload(); };

  const sorted = useMemo(() => [...people].sort((a, b) => {
    const ap = /nancy pelosi/i.test(a.name) ? -20 : 0;
    const bp = /nancy pelosi/i.test(b.name) ? -20 : 0;
    return ap - bp || Number(Boolean(b.publishedIndexHash)) - Number(Boolean(a.publishedIndexHash)) || a.name.localeCompare(b.name);
  }), [people]);
  const heroPerson = sorted[0] ?? null;
  const spotlight = sorted.slice(1, 5);
  const query = localQuery.trim().toLowerCase();
  const directory = useMemo(() => people.filter((person) => !query || `${person.name} ${person.office ?? ""} ${person.state ?? ""}`.toLowerCase().includes(query)), [people, query]);
  const loading = !people.length && (
    trackerResult.loading ||
    peopleResult.loading ||
    (legacyNeeded && legacyResult.data == null && legacyResult.error == null)
  );

  return <div className={styles.home}>
    <section className={styles.hero}>
      <div className={styles.heroCopy}>
        <span className={styles.kicker}>PUBLIC MONEY · CULTURE EDITION</span>
        <h1>Follow the money.<br/><em>Literally.</em></h1>
        <p>Public portfolios from politicians and famous operators, turned into clean indexes normal people can actually understand.</p>
        <div className={styles.heroActions}>
          <a href="#people" className={styles.primary}>Explore people <Icon name="arrow" size={16}/></a>
          <Link href="/feed" className={styles.secondary}>See the disclosure tape</Link>
        </div>
        <div className={styles.heroFoot}><span>Public filings</span><i/><span>Transparent methodology</span><i/><span>You sign every live copy</span></div>
      </div>

      <div className={styles.heroVisual}>
        {heroPerson ? <Link href={`/p/${encodeURIComponent(heroPerson.id)}`} className={styles.heroPortraitCard}>
          <Portrait person={heroPerson} />
          <div className={styles.heroPersonTop}><span>01</span><span>{heroPerson.publishedIndexHash ? "PERSON INDEX" : "PUBLIC PROFILE"}</span></div>
          <div className={styles.heroPersonBottom}>
            <div><small>{personContext(heroPerson)}</small><strong>{heroPerson.publishedIndexHash ? displayIndexName(heroPerson) : heroPerson.name}</strong>{heroPerson.publishedIndexHash ? <PublishedMeta hash={heroPerson.publishedIndexHash}/> : heroPerson.indexName ? <span>{heroPerson.bookState ? heroPerson.bookState.replaceAll("-", " ") : "Public disclosure model"}</span> : <span>Track the public record</span>}</div>
            <span className={styles.roundArrow}><Icon name="arrow" size={20}/></span>
          </div>
        </Link> : <div className={styles.heroPortraitCard}><div className={styles.heroSkeleton}/></div>}
        <div className={styles.heroSticker}>NO LOBBYIST<br/>REQUIRED</div>
      </div>
    </section>

    <section id="people" className={styles.peopleSection}>
      <header className={styles.sectionHeader}>
        <div><span>PEOPLE ARE THE INDEX</span><h2>Pick a person.<br/>See the portfolio.</h2></div>
        <p>Less screener, more discovery. Start with the person you already know, then go as deep into the filings as you want.</p>
      </header>
      {loading ? <div className={styles.loadingGrid}>{[0,1,2,3].map((i)=><div key={i}/>)}</div> : directoryError ? <PageError error={directoryError} retry={retryDirectory}/> : <div className={styles.coverGrid}>
        {(spotlight.length ? spotlight : sorted.slice(0,4)).map((person, index) => <PersonCover key={person.id} person={person} featured={index === 0}/>) }
      </div>}
    </section>

    <section className={styles.tapeSection}>
      <div className={styles.tapeIntro}><span>THE TAPE</span><h2>What moved<br/>this week.</h2><p>Recent public filings, translated from paperwork into something you can scan in ten seconds.</p><Link href="/feed">Open full feed <Icon name="arrow" size={14}/></Link></div>
      <FilingTape disclosures={disclosures} error={!disclosures.length ? disclosureResult.error : null} loading={disclosureResult.loading} retry={disclosureResult.reload}/>
    </section>

    {!directoryError ? <section className={styles.directorySection}>
      <div className={styles.directoryTop}>
        <div><span>THE DIRECTORY</span><h2>Everyone we&apos;re watching.</h2></div>
        <label className={styles.directorySearch}><Icon name="search" size={16}/><input value={localQuery} onChange={(e)=>setLocalQuery(e.target.value)} placeholder="Search people…"/></label>
      </div>
      {!directory.length ? <div className={styles.noResults}>No matching people yet.</div> : <div className={styles.directoryList}>{directory.slice(0, visible).map((person, index) => <Link href={`/p/${encodeURIComponent(person.id)}`} className={styles.directoryRow} key={person.id}>
        <span className={styles.directoryIndex}>{String(index + 1).padStart(2,"0")}</span>
        <Portrait person={person}/>
        <div><strong>{person.name}</strong><small>{personContext(person)}</small></div>
        <span className={styles.directoryState}>{person.publishedIndexHash ? "INDEX" : "WATCH"}</span>
        <span className={styles.directoryArrow}><Icon name="arrow" size={16}/></span>
      </Link>)}</div>}
      {directory.length > visible ? <button className={styles.moreButton} type="button" onClick={()=>setVisible(v=>v+10)}>Show more people</button> : null}
    </section> : null}

    <section className={styles.manifesto}>
      <span>THE POINT</span>
      <h2>Influence is concentrated.<br/><em>Information doesn&apos;t have to be.</em></h2>
      <p>InsiderIndex reorganizes delayed public disclosures into understandable research and, where the product actually supports it, user-signed access. No secret feed. No pretend fund.</p>
    </section>
  </div>;
}
