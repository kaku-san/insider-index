"use client";

import Link from "next/link";
import { useState, useSyncExternalStore, type ReactNode } from "react";
import { PersonAvatar } from "./person-avatar";
import { EquityCurve, PortfolioDonut } from "./portfolio-charts";
import { Icon } from "./social/icon";
import { VaultInvest } from "./vault-invest";
import type { BacktestPoint } from "@/lib/disclosures/types";
import styles from "./person-portfolio.module.css";

export { styles as portfolioStyles };

const followEvent = "stocklana:person-follow-changed";
function subscribeToFollows(callback: () => void) {
  window.addEventListener("storage", callback);
  window.addEventListener(followEvent, callback);
  return () => {
    window.removeEventListener("storage", callback);
    window.removeEventListener(followEvent, callback);
  };
}

/** A device-local watch, not an account subscription or a promise of alerts. */
function PersonFollow({ id }: { id: string }) {
  const key = `stocklana:person-follow:${id}`;
  const following = useSyncExternalStore(subscribeToFollows, () => {
    try { return localStorage.getItem(key) === "true"; } catch { return false; }
  }, () => false);
  const [error, setError] = useState<string | null>(null);
  function toggle() {
    try {
      localStorage.setItem(key, String(!following));
      window.dispatchEvent(new Event(followEvent));
      setError(null);
    } catch { setError("This browser could not save your follow. Allow local storage and try again."); }
  }
  return <div className={styles.follow}>
    <button type="button" className={styles.followButton} aria-pressed={following} onClick={toggle}>
      <Icon name={following ? "check" : "people"} size={17} />{following ? "Following" : "Follow"}
    </button>
    <p>Saved on this device. No alerts or automatic trades.</p>
    {error && <p role="alert">{error}</p>}
  </div>;
}

export function PortfolioLayout({ id, name, indexName, image, context, strategy, count, countNote, children, notice }: {
  id: string; name: string; indexName?: string; image: string | null; context: string; strategy: string;
  count: number | null; countNote: string; children: ReactNode; notice?: ReactNode;
}) {
  return <div className={styles.page}>
    <Link href="/#directory" className={styles.back}><Icon name="arrow" size={15} style={{ transform: "rotate(180deg)" }} />People &amp; indexes</Link>
    <header className={styles.hero}>
      <PersonAvatar name={name} imageUrl={image} size="xl" />
      <div><p className={styles.context}>{indexName ? `${name} · ${context}` : context}</p><h1>{indexName ?? `${name} portfolio`}</h1><p className={styles.strategy}>{strategy}</p></div>
    </header>
    <dl className={styles.stats} aria-label="Portfolio statistics">
      <div><dt>Total value</dt><dd aria-label="Unavailable">—</dd><small>No verified current valuation</small></div>
      <div><dt>Performance</dt><dd aria-label="Unavailable">—</dd><small>No live vault return</small></div>
      <div><dt>Disclosed entries</dt><dd>{count ?? "—"}</dd><small>{countNote}</small></div>
    </dl>
    {notice}
    <div className={styles.layout}>
      <div className={styles.content}>{children}</div>
      <aside id="invest" className={styles.rail} aria-labelledby="invest-title">
        <div className={styles.invest}>
          <span className={styles.badge}><Icon name="clock" size={13} />Vault not live</span>
          <h2 id="invest-title">Invest in this index</h2>
          <p>One investment. A share of the index.</p>
          <div className={styles.flow}><span>USDC</span><Icon name="arrow" size={18} /><span>Index shares</span></div>
          <p id="invest-blocker">No live, execution-approved share-token vault is connected. Deposits and signing are unavailable.</p>
          <button type="button" className={styles.investButton} disabled aria-describedby="invest-blocker">Invest in this index</button>
          <PersonFollow id={id} />
          <p className={styles.finePrint}>When an index vault launches, USDC will buy its share token—not individual stock tokens in your wallet. The devnet test below does not track this person.</p>
          <VaultInvest />
        </div>
        <p className={styles.railNote}><Icon name="shield" size={16} />Public disclosures are delayed and may be incomplete. Tracking does not imply affiliation or endorsement.</p>
      </aside>
    </div>
  </div>;
}

export function PerformancePanel({ points = [] }: { points?: BacktestPoint[] }) {
  const hasSeries = points.filter((point) => Number.isFinite(point.equity)).length >= 2;
  return <section className={styles.panel} aria-labelledby="performance-title">
    <div className={styles.sectionHead}><h2 id="performance-title">Portfolio performance</h2><span className={styles.badge}>Historical simulation</span></div>
    <div className={styles.chartLegend}><span><i />Portfolio</span><span><i />S&amp;P 500 · comparison unavailable</span></div>
    {hasSeries ? <EquityCurve points={points} label="Historical simulation · not live vault performance" /> :
      <div className={styles.emptyChart}>
        <Icon name="clock" size={28} />
        <h3>Performance is not available yet</h3>
        <p>A historical simulation and S&amp;P 500 comparison need a verified price series. No return curve is drawn until that data exists.</p>
      </div>}
    <p className={styles.caption}>Historical simulations are not actual investment results. Live performance will require a funded vault and a verified NAV history.</p>
  </section>;
}

export function AllocationPanel({ allocations = [], children }: {
  allocations?: { ticker: string; weightBps: number }[]; children?: ReactNode;
}) {
  return <section className={styles.panel} aria-labelledby="allocation-title">
    <div className={styles.sectionHead}><h2 id="allocation-title">Holdings distribution</h2><span className={styles.badge}>Published target</span></div>
    {allocations.length ? <>
      <p className={styles.caption}>Published index weights, not the person’s current ownership. Buys and sales both contribute to this separate activity model.</p>
      <div className={styles.allocation}>
        <PortfolioDonut title="Published index target" holdings={allocations.map((item) => ({ ticker: item.ticker, weightPct: item.weightBps / 10000, venueSymbol: null, valueUsd: 0 }))} />
        {children}
      </div>
    </> : <div className={styles.emptyAllocation}><div className={styles.emptyRing} aria-hidden="true" /><div><h3>No published allocation yet</h3><p>The disclosed book remains visible. Dollar ranges and unresolved asset names are not exact weights, so there is no allocation pie to draw.</p></div></div>}
  </section>;
}

export function TableRegion({ label, children }: { label: string; children: ReactNode }) {
  return <div className={styles.tableRegion} role="region" aria-label={label} tabIndex={0}>{children}</div>;
}

export function FilingLink({ url }: { url: string | null }) {
  if (!url || !/^https?:\/\//i.test(url)) return <span className={styles.caption}>Source link unavailable</span>;
  return <a className={styles.sourceLink} href={url} target="_blank" rel="noreferrer">Source filing <span aria-hidden="true">↗</span></a>;
}

export function MissingValue() { return <span aria-label="Unavailable">—</span>; }
