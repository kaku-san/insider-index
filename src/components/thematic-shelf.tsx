"use client";

import Link from "next/link";
import Image from "next/image";
import { indexContentFor } from "@/lib/frontend/index-content";
import { themeArtFor } from "@/lib/frontend/theme-art";
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
          <p>Explore themes built from public disclosures. Open a basket to see its holdings and source.</p>
        </div>
        {directory && <span className={styles.count}>{directory.count} themes</span>}
      </div>
      <div className={styles.modelNote}>
        <Icon name="shield" size={18} />
        <p>
          <strong>Disclosure-based models.</strong> Current investment availability is shown on each index page. Sources and methodology are in About.
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
                <Image src={themeArtFor(index.id)?.thumb ?? `/index-assets/themes/${index.id}-hero.png`} alt={themeArtFor(index.id)?.alt ?? ""} width={72} height={72} style={{ borderRadius: 12 }} /><span className={styles.modelBadge}>Theme index</span>
              </div>
              <h3>{index.name}</h3>
              <p className={styles.personMeta}>{indexContentFor(index.id)?.cardHook ?? index.headline}</p>
              <small>{index.top5.map((t) => t.ticker).join(" · ")}</small>
              <p className={styles.personMeta}>
                {index.legs} holdings · {index.members} source filers
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
