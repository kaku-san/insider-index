"use client";

import { useResource } from "@/lib/frontend/use-resource";
import { PREVIEW_MODE } from "@/lib/frontend/api";
import type { FomoProfile, CopySignal } from "@/lib/disclosures/types";
import { disclosedRange } from "@/lib/frontend/disclosure-labels";
import { PageError, Skeleton, EmptyState } from "./social/shared";
import { FmpPerson } from "./fmp-portfolio";
import {
  AllocationPanel, FilingLink, MissingValue, PerformancePanel, PortfolioLayout,
  TableRegion, portfolioStyles as styles,
} from "./person-portfolio";

type ProfileData = { profile: FomoProfile; trades: CopySignal[] };

/** Legacy URLs share the portfolio layout; Congress resolves to its saved FMP book. */
export function ProfileView({ id, initialData }: { id: string; initialData?: ProfileData }) {
  const resource = useResource<ProfileData>(`/api/profiles/${encodeURIComponent(id)}`, initialData);
  const profile = resource.data?.profile;
  if (resource.loading && !profile) return <Skeleton />;
  if (resource.error && !profile) return <PageError error={resource.error} retry={resource.reload} />;
  if (!profile) return <EmptyState title="Profile not found." description="This public profile is unavailable." />;
  if (profile.kind === "politician" && /^[A-Z][0-9]{6}$/.test(profile.cikOrBioguide)) {
    return <FmpPerson key={profile.cikOrBioguide} id={profile.cikOrBioguide} />;
  }
  const trades = [...(resource.data?.trades ?? [])].sort((a, b) => b.transactionDate.localeCompare(a.transactionDate));
  return <PortfolioLayout id={id} name={profile.name} image={profile.imageUrl} context={profile.title}
    strategy="Follow publicly disclosed positions and the trades behind them."
    count={profile.portfolio.length || null} countNote="Names on the filing record · not live holdings"
    notice={PREVIEW_MODE ? <div className={styles.notice}>Illustrative preview. These are fictional figures, not an actual portfolio.</div> : resource.error ? <div className={styles.notice} role="alert">Could not refresh this profile. Showing the last loaded observation.<button onClick={resource.reload}>Retry</button></div> : undefined}>
    <PerformancePanel points={profile.curve} />
    <section className={styles.panel} aria-labelledby="holdings-title">
      <div className={styles.sectionHead}><h2 id="holdings-title">Current holdings</h2><span className={styles.badge}>Disclosed book · not live</span></div>
      <p className={styles.caption}>{profile.kind === "politician" ? "Reported purchase and sale ranges, not share counts or a verified current balance." : "Positions reported after the latest Form 4 print, valued at that disclosed print’s price—not a current market quote."} Every disclosed name stays visible, including sold and exited positions.</p>
      {profile.portfolio.length ? <TableRegion label="Disclosed positions; scroll for all columns"><table className={styles.table}>
        <thead><tr><th scope="col">Ticker / asset</th><th scope="col" className={styles.number}>Last price</th><th scope="col" className={styles.number}>Disclosed value</th><th scope="col" className={styles.number}>Weight</th></tr></thead>
        <tbody>{profile.portfolio.map((holding) => <tr key={holding.ticker}>
          <td><strong>{holding.ticker}</strong><small>{holding.issuerName}</small><small>{holding.status} · latest trade {holding.lastTradeAt.slice(0, 10)}</small></td>
          <td className={styles.number}><MissingValue /></td>
          <td className={styles.number}>{disclosedRange({ low: holding.valueLow, high: holding.valueHigh })}</td>
          <td className={styles.number}><MissingValue /></td>
        </tr>)}</tbody>
      </table></TableRegion> : <div className={styles.empty}><h3>No disclosed book available</h3><p>Missing filings do not mean the person owns nothing.</p></div>}
      <p className={styles.caption}>No current price feed or published target weights are available for this book.</p>
    </section>
    <AllocationPanel />
    <section className={styles.panel} aria-labelledby="activity-title">
      <div className={styles.sectionHead}><h2 id="activity-title">Allocation history / trades</h2><span className={styles.badge}>{trades.length} disclosures</span></div>
      <p className={styles.caption}>Reported transactions, not executed vault rebalances.</p>
      {trades.length ? <TableRegion label="Disclosed trade history"><table className={styles.table}>
        <thead><tr><th scope="col">Trade date</th><th scope="col">Ticker</th><th scope="col">Activity</th><th scope="col" className={styles.number}>Amount range</th></tr></thead>
        <tbody>{trades.map((trade) => <tr key={trade.id}>
          <td>{trade.transactionDate.slice(0, 10)}<small>Disclosed {trade.filedAt.slice(0, 10)}</small><FilingLink url={null} /></td>
          <td><strong>{trade.ticker}</strong><small>{trade.issuerName}</small></td>
          <td><span className={styles.event} data-side={trade.side}>{trade.side === "buy" ? "Buy" : trade.side === "sell" ? "Sell" : "Other"}</span></td>
          <td className={styles.number}>{disclosedRange({ low: trade.amountLow, high: trade.amountHigh })}</td>
        </tr>)}</tbody>
      </table></TableRegion> : <div className={styles.empty}><h3>No trade history available</h3><p>Transactions will appear when disclosure records are available.</p></div>}
    </section>
  </PortfolioLayout>;
}
