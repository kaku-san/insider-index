"use client";

import Link from "next/link";
import { useResource } from "@/lib/frontend/use-resource";
import { Skeleton } from "./social/shared";
import { Icon } from "./social/icon";
import styles from "./disclosure-workspace.module.css";

type Directory = {
  count: number;
  generatedAt: string;
  indexes: {
    id: string;
    slug: string;
    name: string;
    headline: string;
    tagline: string;
    hook: string;
    lane: string;
    legs: number;
    members: number;
    top5: { ticker: string; weightBps: number }[];
    href: string;
    badge: string;
  }[];
};

/** Curated multi-member themes from the committed live feed. */
export function ThematicShelf() {
  const resource = useResource<Directory>("/api/thematic-indexes");
  const directory = resource.data;
  return (
    <section id="thematic" className={styles.section} aria-labelledby="thematic-title">
      <div className={styles.sectionHead}>
        <div>
          <h2 id="thematic-title">Thematic indexes</h2>
          <p>Multi-member stories from public filings — not celebrity clones. Person trackers stay on profile pages.</p>
        </div>
        {directory && <span className={styles.count}>{directory.count} themes</span>}
      </div>
      <div className={styles.modelNote}>
        <Icon name="shield" size={18} />
        <p>
          <strong>Research models.</strong> Catalog-tradable legs only. Basket Buy unavailable. Sources: House Clerk /
          Senate eFD via FMP, PelosiTracker context, Solana catalog.
        </p>
      </div>
      {!directory ? (
        resource.error ? (
          <div className={styles.empty} role="alert">
            <h3>Thematic indexes couldn’t load.</h3>
            <p>The committed feed is temporarily unavailable.</p>
            <button className={styles.secondaryButton} onClick={resource.reload}>Try again</button>
          </div>
        ) : (
          <Skeleton cards={2} />
        )
      ) : (
        <div className={styles.indexShelf}>
          {directory.indexes.map((index) => (
            <article key={index.id} className={styles.indexTile}>
              <div className={styles.tileTop}>
                <span className={styles.modelBadge}>{index.badge}</span>
              </div>
              <h3>{index.name}</h3>
              <p className={styles.personMeta}>{index.headline}</p>
              <small>{index.top5.map((t) => t.ticker).join(" · ")}</small>
              <p className={styles.personMeta}>
                {index.legs} names · {index.members} members · {index.lane}
              </p>
              <div className={styles.tileBottom}>
                <Link className={styles.indexLink} href={index.href}>
                  Open theme <Icon name="arrow" size={17} />
                </Link>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
