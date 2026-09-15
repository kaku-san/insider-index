"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import type { CopySignal } from "@/lib/disclosures/types";
import { useResource } from "@/lib/frontend/use-resource";
import { useUI } from "./providers/ui-provider";
import { moneyBand, shortDate } from "@/lib/frontend/research-format";
import { portraitFor } from "@/lib/fomo/portraits";
import { PersonAvatar } from "./person-avatar";
import { Icon } from "./social/icon";
import { PageError, Skeleton } from "./social/shared";
import styles from "./consumer-feed.module.css";

type DisclosureResponse = { disclosures?: CopySignal[]; rows?: CopySignal[]; partial?: boolean; source?: string } | CopySignal[];

function rowsOf(data: DisclosureResponse | null): CopySignal[] {
  if (!data) return [];
  if (Array.isArray(data)) return data;
  return data.disclosures ?? data.rows ?? [];
}

export function ConsumerFeed() {
  const resource = useResource<DisclosureResponse>("/api/disclosures");
  const ui = useUI();
  const [filter, setFilter] = useState<"all" | "following" | "buy" | "sell">("all");
  const [query, setQuery] = useState("");
  const rows = useMemo(() => rowsOf(resource.data), [resource.data]);
  const visible = useMemo(() => rows.filter((item) => {
    if (filter === "following" && !ui.deviceFollows.includes(item.profileId)) return false;
    if (filter === "buy" && item.side !== "buy") return false;
    if (filter === "sell" && item.side !== "sell") return false;
    const q = query.trim().toLowerCase();
    return !q || `${item.insiderName} ${item.ticker} ${item.issuerName}`.toLowerCase().includes(q);
  }), [rows, filter, ui.deviceFollows, query]);

  if (resource.loading) return <Skeleton />;
  if (resource.error) return <PageError error={resource.error} retry={resource.reload} />;

  return <div className={styles.page}>
    <section className={styles.hero}>
      <span className={styles.kicker}>PUBLIC MOVES · ONE PRINT AT A TIME</span>
      <h1>The paper trail,<br/><em>while it&apos;s still interesting.</em></h1>
      <p>New public disclosures from politicians and executives. Eligible prints can be reviewed as a single wallet-signed copy trade. Nothing auto-trades.</p>
    </section>

    <section className={styles.toolbar} aria-label="Feed filters">
      <div className={styles.filters}>
        {([['all','All'],['following','Following'],['buy','Buys'],['sell','Sells']] as const).map(([value,label]) => <button key={value} className={filter === value ? styles.active : undefined} onClick={() => setFilter(value)}>{label}{value === 'following' && ui.deviceFollows.length ? <span>{ui.deviceFollows.length}</span> : null}</button>)}
      </div>
      <label className={styles.search}><Icon name="search" size={16}/><input value={query} onChange={(event)=>setQuery(event.target.value)} placeholder="Person or ticker"/></label>
    </section>

    <div className={styles.legend}><span>Trade date</span><span>Filed</span><span>Public range</span><span>Action</span></div>

    <section className={styles.tape}>
      {visible.map((item) => {
        const image = item.imageUrl ?? portraitFor(item.profileId);
        const action = item.side === "buy" ? "bought" : item.side === "sell" ? "sold" : "reported";
        return <article className={styles.row} key={item.id}>
          <div className={styles.identity}>
            <PersonAvatar name={item.insiderName} imageUrl={image} size="md"/>
            <div><Link href={`/p/${encodeURIComponent(item.profileId)}`}>{item.insiderName}</Link><small>{[item.chamber, item.state].filter(Boolean).join(" · ") || item.insiderTitle || "Public filer"}</small></div>
          </div>
          <div className={styles.move}><span className={`${styles.side} ${styles[item.side]}`}>{action}</span><strong>{item.ticker}</strong><small>{item.issuerName}</small></div>
          <div className={styles.when}><strong>{shortDate(item.transactionDate)}</strong><small>trade date</small></div>
          <div className={styles.when}><strong>{shortDate(item.filedAt)}</strong><small>filed</small></div>
          <div className={styles.amount}><strong>{moneyBand({ low: item.amountLow, high: item.amountHigh })}</strong><small>disclosed range</small></div>
          <div className={styles.action}>{item.tradeEligible ? <Link className={styles.copyButton} href={`/trade/${encodeURIComponent(item.id)}?copy=1`}>Copy one <Icon name="arrow" size={14}/></Link> : <span className={styles.notMapped}>Research only</span>}</div>
        </article>;
      })}
      {!visible.length ? <div className={styles.empty}><Icon name="file" size={26}/><h2>No matching disclosures.</h2><p>{filter === "following" && !ui.deviceFollows.length ? "Follow people from Explore first, then their public moves will collect here." : "Try a different filter or search."}</p><Link href="/">Explore people <Icon name="arrow" size={14}/></Link></div> : null}
    </section>

    <aside className={styles.footerNote}><Icon name="info" size={16}/><p><strong>Public disclosures, not live positions.</strong> Transaction date, filing date and on-chain execution are different clocks. InsiderIndex keeps them separate.</p><Link href="/methodology">How it works</Link></aside>
  </div>;
}
