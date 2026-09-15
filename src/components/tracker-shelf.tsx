"use client";
import Link from "next/link";
import { useResource } from "@/lib/frontend/use-resource";
import type { TrackerDirectoryView } from "@/lib/tracker/views";
import { Skeleton } from "./social/shared";
import { PersonAvatar } from "./person-avatar";
import { Icon } from "./social/icon";
import styles from "./disclosure-workspace.module.css";

const date = (value: string) => new Date(`${value}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const usdCompact = (value: number) => value.toLocaleString("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1 });

/** All 20 PelosiTracker handoff people, served from the committed dataset. */
export function TrackerShelf({ initialData }: { initialData?: TrackerDirectoryView }) {
  const resource = useResource<TrackerDirectoryView>("/api/tracker", initialData);
  const directory = resource.data;
  return <section id="tracker" className={styles.section} aria-labelledby="tracker-title">
    <div className={styles.sectionHead}><div><h2 id="tracker-title">PelosiTracker top 20</h2><p>Current positions as modelled by PelosiTracker, scraped {directory ? date(directory.asOf) : "2026-09-15"}. Third-party estimates, not net worth and not a vault NAV.</p></div>{directory && <span className={styles.count}>{directory.count} people · {directory.people.filter((p) => p.index.readiness.status === "VAULT_CANDIDATE").length} vault candidates</span>}</div>
    <div className={styles.modelNote}><Icon name="info" size={18} /><p><strong>Two dated sources, kept apart.</strong> Each person page shows the tracker’s current positions beside the older FMP annual disclosure, the tracker’s recent trades as information only, and a tracker-positions index whose weights never come from trades.</p></div>
    {!directory ? resource.error ? <div className={styles.empty} role="alert"><h3>The tracker shelf couldn’t load.</h3><p>The committed handoff is temporarily unavailable.</p><button className={styles.secondaryButton} onClick={resource.reload}>Try again</button></div> : <Skeleton cards={2} /> :
      <div className={styles.trackerShelf}>{directory.people.map((person) => <article key={person.id} className={styles.trackerTile}>
        <div><PersonAvatar name={person.name} imageUrl={person.photo.local} size="md" /><div><strong>{person.name}</strong><small>{[person.title, person.state, person.party].filter(Boolean).join(" · ")}</small></div><span className={styles.trackerRank}>#{person.rank}</span></div>
        <div className={styles.trackerValue}><span>Tracker value · {date(person.asOf)}</span><strong>{person.portfolioValueUsd !== null ? usdCompact(person.portfolioValueUsd) : "—"}</strong></div>
        <small>{person.topTickers.join(" · ")}</small>
        <span className={styles.trackerStatus} data-status={person.index.readiness.status}>{person.index.readiness.status === "VAULT_CANDIDATE" ? `Vault candidate · ${person.index.constituents} names` : "Wait readiness"}{person.index.readiness.firstLiveCandidate ? " · first live" : ""}</span>
        <div className={styles.trackerLinks}><Link className={styles.bookLink} href={`/p/${person.id}`}>Person page</Link><Link className={styles.bookLink} href={`/indexes/${person.index.id}`}>Tracker index</Link></div>
      </article>)}</div>}
    {directory && <p className={styles.finePrint}>PelosiTracker handoff · {directory.count} profiles · photos {directory.count}/{directory.count} · Raydium pool evidence observed {date(directory.poolSnapshot.fetchedAt.slice(0, 10))}. Public funds disabled ({directory.release.status}).</p>}
  </section>;
}
