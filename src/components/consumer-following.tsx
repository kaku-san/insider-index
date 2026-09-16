"use client";

import { useMemo } from "react";
import Link from "next/link";
import { useResource } from "@/lib/frontend/use-resource";
import type { FomoProfile } from "@/lib/disclosures/types";
import type { PeopleDirectoryResponse, ResearchPerson } from "@/lib/frontend/research-contract";
import { useUI } from "./providers/ui-provider";
import { personContext, slugifyPerson } from "@/lib/frontend/research-format";
import { portraitFor } from "@/lib/fomo/portraits";
import { PersonAvatar } from "./person-avatar";
import { Icon } from "./social/icon";
import { PageError, Skeleton } from "./social/shared";
import styles from "./consumer-following.module.css";

type LegacyProfiles = {profiles:FomoProfile[]};
type PersonView = ResearchPerson & { imageUrl?: string | null; mapped?: number };

export function ConsumerFollowing(){
  const people = useResource<PeopleDirectoryResponse>("/api/people");
  const primaryHasPeople = Boolean(people.data?.people?.length);
  const legacyNeeded = !people.loading && !primaryHasPeople;
  const legacy = useResource<LegacyProfiles>(legacyNeeded ? "/api/profiles" : null);
  const ui = useUI();
  const all = useMemo<PersonView[]>(() => {
    const current = people.data?.people?.map((p)=>({...p,imageUrl:p.image ?? portraitFor(slugifyPerson(p.name))})) ?? [];
    if(current.length) return current;
    return (legacy.data?.profiles ?? []).map((p)=>({id:p.id,name:p.name,position:p.title,chamber:p.chamber,party:p.party,state:p.state,imageUrl:p.imageUrl ?? portraitFor(slugifyPerson(p.name)),publishedIndexHash:null,indexName:p.index?.name,bookState:"legacy",mapped:p.index?.constituents?.length ?? 0}));
  },[people.data,legacy.data]);
  const selected = all.filter((p)=>ui.deviceFollows.includes(p.id));
  const loadError = !all.length && !people.loading && !legacy.loading ? legacy.error ?? people.error : null;
  if(!all.length && (people.loading || (legacyNeeded && legacy.data == null && legacy.error == null))) return <Skeleton/>;
  if(loadError) return <PageError error={loadError} retry={()=>{people.reload();legacy.reload();}}/>;
  return <div className={styles.page}>
    <header className={styles.hero}><span>YOUR WATCHLIST</span><h1>Following</h1><p>People you want to keep an eye on. New public moves surface in Feed; following never enables automatic trading.</p><Link href="/feed">Open Feed <Icon name="arrow" size={14}/></Link></header>
    {!selected.length ? <section className={styles.empty}><div className={styles.emptyFaces}><span/><span/><span/></div><h2>Your watchlist is still quiet.</h2><p>Follow a politician or executive to collect their public filings and new moves in one place.</p><Link href="/">Find someone interesting <Icon name="arrow" size={14}/></Link></section> : <section className={styles.grid}>{selected.map((person)=><article className={styles.card} key={person.id}>
      <Link className={styles.profile} href={`/p/${encodeURIComponent(person.id)}`}><PersonAvatar name={person.name} imageUrl={person.imageUrl} size="xl"/><div className={styles.identity}><span>{person.publishedIndexHash ? "PERSON INDEX" : "PUBLIC BOOK"}</span><h2>{person.name}</h2><p>{personContext(person)}</p></div></Link>
      <div className={styles.meta}><div><strong>{person.publishedIndexHash ? "Published model" : "Research"}</strong><small>Status</small></div>{typeof person.mapped === 'number' ? <div><strong>{person.mapped}</strong><small>Mapped names</small></div> : null}</div>
      <div className={styles.actions}><Link href={`/p/${encodeURIComponent(person.id)}`}>View portfolio <Icon name="arrow" size={14}/></Link><button onClick={()=>ui.toggleDeviceFollow(person.id)}>Following <Icon name="check" size={13}/></button></div>
    </article>)}</section>}
  </div>;
}
