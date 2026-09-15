"use client";
import Link from "next/link";
import { useResource } from "@/lib/frontend/use-resource";
import type { TrackerPersonView } from "@/lib/tracker/views";
import { PageError, Skeleton } from "./social/shared";
import { Icon } from "./social/icon";
import { PersonAvatar } from "./person-avatar";
import styles from "./disclosure-workspace.module.css";

const date = (value: string) => new Date(value.length === 10 ? `${value}T00:00:00Z` : value).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const usdCompact = (value: number) => value.toLocaleString("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1 });

function InvestPanel({ view }: { view: TrackerPersonView }) {
  const { readiness } = view.index;
  return <aside id="invest" className={styles.investPanel} aria-labelledby="invest-title">
    <span className={styles.count}>{readiness.status === "VAULT_CANDIDATE" ? "Vault candidate · funds disabled" : "Wait readiness"}</span>
    <h2 id="invest-title">{readiness.firstLiveCandidate ? "First live candidate" : "Research the target"}</h2>
    <p id="invest-blocker">{readiness.status === "VAULT_CANDIDATE" ? "The composition is vault-ready on paper: every name has a mint and an observed Raydium USDC pool. Public funds stay disabled until deployer readiness evidence, route checks and release gates pass." : "The tracker positions do not yet yield two investable names with mint and Raydium pool evidence. Nothing is substituted or invented."} Basket buying, deposits and signing are unavailable ({view.release.status}).</p>
    <button className={styles.secondaryButton} disabled aria-describedby="invest-blocker">Invest unavailable</button>
    <Link className={styles.primaryButton} href="/feed">Copy one print from the feed</Link>
    <p className={styles.finePrint}>Exit is USDC only: holders never receive a bag of xStocks, and in-kind redemption is not the product. Exit stays disabled until a USDC-out quote exists and the 0 bps host exit fee is what the transaction does (host exit fee {view.release.hostExitFeeBps} bps; native USDC exit verified: {view.release.nativeUsdcExitVerified ? "yes" : "no"}). Individual copies are separate user-signed swaps, not ownership of this model. PelosiTracker’s dollar total is not this index’s NAV.</p>
  </aside>;
}

export function TrackerIndex({ personId, initialData, fmpIndexHash }: { personId: string; initialData?: TrackerPersonView; fmpIndexHash: string | null }) {
  const resource = useResource<TrackerPersonView>(`/api/tracker/${encodeURIComponent(personId)}`, initialData);
  if (resource.error && !resource.data) return <PageError error={resource.error} retry={resource.reload} />;
  if (!resource.data) return <Skeleton cards={2} />;
  const view = resource.data;
  const { index, profile } = view;
  const total = index.constituents.reduce((sum, row) => sum + row.weightBps, 0);
  return <div className={styles.workspace}>
    <Link className={styles.backLink} href={`/p/${profile.id}`}><Icon name="arrow" size={16} style={{ transform: "rotate(180deg)" }} />Shown book, trades &amp; FMP comparison</Link>
    <header className={styles.indexHero}>
      <span className={styles.kicker}>The index desk · PelosiTracker positions as of {date(index.asOf)}</span>
      <div style={{ display: "flex", alignItems: "center", gap: 16 }}><PersonAvatar name={profile.name} imageUrl={profile.photo.local} size="lg" /><h1>{index.indexName}</h1></div>
      <p>{profile.name} · #{profile.rank} on PelosiTracker by estimated portfolio value. Weights come from the tracker’s current positions, never from its trade tape or its dollar total.</p>
    </header>
    <div className={styles.indexLayout}>
      <section className={styles.targetPanel} aria-label="Tracker-positions index target">
        <span className={styles.modelBadge}>Vault-ready composition · {index.readiness.status === "VAULT_CANDIDATE" ? "vault candidate" : "wait readiness"} · not live holdings</span>
        <h2>Inside the index</h2><p>{index.label}</p>
        <div className={styles.targetMeta}><span>Tracker positions as of {date(index.asOf)}</span><span>Raydium pools observed {date(view.poolSnapshot.fetchedAt)}</span><span>{index.constituents.length} names · {total.toLocaleString("en-US")} bps</span></div>
        <div className={styles.modelNote}><Icon name="info" size={17} /><p><strong>Proportions, not a NAV.</strong> {index.navDisclaimer} Covers {index.coverage.includedTrackerPercentage.toFixed(2)}% of the tracker book out of {index.coverage.listedTrackerPercentage.toFixed(2)}% listed in its top {index.coverage.holdingsSlice}.</p></div>
        {index.constituents.length ? <div className={styles.tableWrap} role="region" aria-label="Index target weights, scroll for mint and pool addresses" tabIndex={0}>
          <table className={styles.table}><caption>{index.constituents.length} names with mint and Raydium USDC pool. Targets rounded to basis points.</caption><thead><tr><th scope="col">Asset</th><th scope="col">Target weight</th><th scope="col">Tracker position</th><th scope="col">Token</th><th scope="col">Solana mint</th><th scope="col">Raydium USDC pool</th></tr></thead><tbody>{index.constituents.map((row) => <tr key={row.token.mint}><td><strong>{row.ticker}</strong></td><td className={styles.weight}>{(row.weightBps / 100).toFixed(2)}%</td><td>{row.trackerPercentage.toFixed(2)}%</td><td>{row.token.issuer === "xstock" ? "xStock" : "Backpack"} · {row.token.symbol}</td><td><code className={styles.mint}>{row.token.mint}</code></td><td><code className={styles.mint}>{row.pool.pool}</code><br /><small>{row.pool.kind === "raydium_clmm" ? "CLMM" : "CPMM"} · TVL {usdCompact(row.pool.tvlUsd)}</small></td></tr>)}</tbody></table>
        </div> : <div className={styles.modelNote}><Icon name="info" size={17} /><p>No tracker position has both a catalog mint and an observed Raydium USDC pool yet. The positions remain on the shown book.</p></div>}
        <details className={styles.sourceDetails}><summary>How this target was built</summary>
          <p>Membership and sizing come only from PelosiTracker’s top {index.coverage.holdingsSlice} positions ({index.sourceLabel}, scraped {date(index.asOf)}): a name needs a Solana catalog mint (xStock first, then Backpack) and an observed mainnet Raydium CLMM/CPMM pool quoted in USDC above the thin-pool floor. The tracker’s position percentages are renormalized over the included names to 10,000 bps by largest remainder. Recent trades are shown on the person page for information and are never an input. The FMP annual disclosure is a separate, older model{fmpIndexHash ? "" : " (none published for this person)"}.</p>
          <p>Readiness: {index.readiness.reasons.join("; ")}.</p>
          <p>Positions outside the target: {index.excluded.length}</p>
          <ul>{index.excluded.map((row) => <li key={`${row.ticker}-${row.reason}`}>{row.ticker}{row.trackerPercentage !== null ? ` (${row.trackerPercentage.toFixed(2)}%)` : ""}: {row.reason.replaceAll("-", " ")}{row.token ? ` · ${row.token.symbol} ${row.token.mint}` : ""}</li>)}</ul>
          {fmpIndexHash && <p><Link href={`/indexes/fmp-${fmpIndexHash}`}>Open the FMP annual-disclosure model for the same person</Link></p>}
          <p className={styles.targetVersion}>Index id: <code>{index.id}</code> · basis <code>{index.basis}</code> · methodology <code>{index.methodology}</code></p>
        </details>
      </section>
      <InvestPanel view={view} />
    </div>
  </div>;
}
