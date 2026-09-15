"use client";

import Link from "next/link";
import { useState, useSyncExternalStore, type ReactNode } from "react";
import { PersonAvatar } from "./person-avatar";
import { EquityCurve, PortfolioDonut } from "./portfolio-charts";
import { Icon } from "./social/icon";
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
    } catch { setError("This browser could not save your watch."); }
  }
  return <div className={styles.follow}>
    <button type="button" className={styles.followButton} aria-pressed={following} onClick={toggle}>
      <Icon name={following ? "check" : "people"} size={16} />{following ? "Watching" : "Add to watchlist"}
    </button>
    <p className={styles.followNote}>Saved on this device. No alerts or automatic trades.</p>
    {error && <p role="alert">{error}</p>}
  </div>;
}

function ShareButton() {
  const [label, setLabel] = useState("Share");
  async function share() {
    const url = window.location.href;
    try {
      if (navigator.share) await navigator.share({ title: document.title, url });
      else {
        await navigator.clipboard.writeText(url);
        setLabel("Link copied");
        window.setTimeout(() => setLabel("Share"), 1800);
      }
    } catch {
      // Native share cancellation is not an error state the page needs to surface.
    }
  }
  return <button type="button" className={styles.shareButton} onClick={share}>{label}</button>;
}

export function PortfolioLayout({ id, name, indexName, image, context, strategy, count, countNote, mappedCount, activityCount, latestFiling, indexHref, children, notice }: {
  id: string; name: string; indexName?: string; image: string | null; context: string; strategy: string;
  count: number | null; countNote: string; mappedCount?: number | null; activityCount?: number; latestFiling?: string | null;
  indexHref?: string; children: ReactNode; notice?: ReactNode;
}) {
  const hasFilingMetadata = latestFiling !== undefined || activityCount !== undefined;
  const hasIndexMetadata = mappedCount !== undefined;

  return <div className={styles.page}>
    <Link href="/#directory" className={styles.back}><Icon name="arrow" size={15} style={{ transform: "rotate(180deg)" }} />People &amp; indexes</Link>
    <header className={styles.heroCard}>
      <div className={styles.heroTop}>
        <div className={styles.heroIdentity}>
          <PersonAvatar name={name} imageUrl={image} size="xl" />
          <div>
            <p className={styles.context}>{indexName ? `${name} · ${context}` : context}</p>
            <h1>{indexName ?? `${name} Tracker`}</h1>
            <p className={styles.strategy}>{strategy}</p>
            {hasFilingMetadata && <p className={styles.heroMeta}>
              {latestFiling ? <>Latest filing <strong>{latestFiling}</strong></> : <>Latest filing <strong>unavailable</strong></>}
              <span aria-hidden="true">•</span>
              <strong>{activityCount ?? "—"}</strong> reported trades saved
            </p>}
          </div>
        </div>
        <div className={styles.heroActions}>
          <PersonFollow id={id} />
          <ShareButton />
          {indexHref ? <Link className={styles.primaryAction} href={indexHref}>View index <Icon name="arrow" size={15} /></Link> :
            hasIndexMetadata ? <button type="button" className={styles.primaryAction} disabled>Index not published</button> : null}
        </div>
      </div>

      <dl className={styles.stats} aria-label="Portfolio statistics">
        <div><dt>Portfolio value</dt><dd aria-label="Unavailable">—</dd><small>No verified live NAV</small></div>
        <div><dt>Performance</dt><dd aria-label="Unavailable">—</dd><small>No verified price series</small></div>
        {hasIndexMetadata && <div><dt>Index holdings</dt><dd>{mappedCount ?? "—"}</dd><small>Mapped stock / ETF names</small></div>}
        <div><dt>Disclosure rows</dt><dd>{count ?? "—"}</dd><small>{countNote}</small></div>
      </dl>
    </header>

    <a className={styles.sourceStrip} href="#holdings-title">
      <span className={styles.sourceIcon}><Icon name="shield" size={18} /></span>
      <span><strong>Where this portfolio comes from</strong><small>Public filings → saved disclosure book → InsiderIndex identity and Solana mapping.</small></span>
      <Icon name="arrow" size={16} />
    </a>

    {notice}
    <aside id="invest" className={`${styles.panel} ${styles.invest}`} aria-labelledby="invest-title">
      <div>
        <div className={styles.sectionHead}><h2 id="invest-title">Research this book</h2><span className={styles.badge}><Icon name="eye" size={13} />Research only</span></div>
        <p className={styles.caption}>Disclosed holdings and model targets are not executable baskets. Basket buying, deposits and signing are unavailable.</p>
      </div>
      <div className={styles.investAction}>
        <p id="invest-blocker" className={styles.caption}>A copy trade buys or sells one catalog-listed stock token from the separate disclosure feed, not this model or index shares.</p>
        <button type="button" className={styles.investButton} disabled aria-describedby="invest-blocker">Basket buying unavailable</button>
        <Link className={styles.sourceLink} href="/feed">Copy one print from the feed</Link>
      </div>
    </aside>
    <div className={styles.content}>{children}</div>
    <p className={styles.disclaimer}>Public disclosures are delayed and may be incomplete. Tracking does not imply affiliation or endorsement.</p>
  </div>;
}

export function PerformancePanel({ points = [] }: { points?: BacktestPoint[] }) {
  const hasSeries = points.filter((point) => Number.isFinite(point.equity)).length >= 2;
  return <section className={`${styles.panel} ${styles.performance}`} aria-labelledby="performance-title">
    <div className={styles.sectionHead}>
      <div><h2 id="performance-title">Portfolio performance</h2><p>Historical model vs. benchmark</p></div>
      <span className={styles.badge}>S&amp;P 500 · comparison unavailable</span>
    </div>
    {hasSeries ? <>
      <div className={styles.chartLegend}><span><i />Portfolio</span><span><i />S&amp;P 500 · comparison unavailable</span></div>
      <EquityCurve points={points} label="Historical simulation · not live vault performance" />
    </> : <div className={styles.emptyChart}>
      <div className={styles.emptyMetric}>—</div>
      <h3>Performance series not available yet</h3>
      <p>InsiderIndex only draws this chart once dated trades can be paired with a verified market-price history.</p>
    </div>}
    <p className={styles.caption}>No return is inferred from filing values. Historical simulations, when available, are not actual investment results.</p>
  </section>;
}

export function AllocationPanel({ allocations = [], children }: {
  allocations?: { ticker: string; weightBps: number }[]; children?: ReactNode;
}) {
  return <section className={styles.panel} aria-labelledby="allocation-title">
    <div className={styles.sectionHead}>
      <div><h2 id="allocation-title">Holdings distribution</h2><p>Published model weights</p></div>
      <span className={styles.badge}>{allocations.length ? `${allocations.length} mapped names` : "No model"}</span>
    </div>
    {allocations.length ? <>
      <div className={styles.allocation}>
        <PortfolioDonut title="Published index target" unit="holdings" holdings={allocations.map((item) => ({ ticker: item.ticker, weightPct: item.weightBps / 10000, venueSymbol: null, valueUsd: 0 }))} />
        {children}
      </div>
      <p className={styles.caption}>Published model weights over mapped equities / ETFs, using disclosed value bands or a labelled equal-weight fallback. They are not the person’s current ownership or live brokerage weights, and trades never rewrite saved annual holdings.</p>
    </> : <div className={styles.emptyAllocation}><div className={styles.emptyRing} aria-hidden="true" /><div><h3>No published allocation yet</h3><p>The disclosed book can still be inspected below. A pie is not drawn until an explicit model exists.</p></div></div>}
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
