"use client";
import Link from "next/link";
import { useResource } from "@/lib/frontend/use-resource";
import { PageError, Skeleton } from "./social/shared";
import { Icon } from "./social/icon";
import type { StoredPerson } from "@/lib/fmp/store";
import type { PublishedTradeIndex } from "@/lib/fmp/trade-index";
import styles from "./disclosure-workspace.module.css";

export { FmpPerson } from "./fmp-portfolio";
export { disclosedRange } from "@/lib/frontend/disclosure-labels";
const date = (value: string) => new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

function InvestPanel() {
  return <aside id="invest" className={styles.investPanel} aria-labelledby="invest-title">
    <span className={styles.count}>Not open for investment</span>
    <h2 id="invest-title">One index. One token.</h2>
    <p>The intended investment flow is USDC into an index vault, in exchange for its share token.</p>
    <div className={styles.investPath}><span>USDC</span><Icon name="arrow" size={18} /><span>Index shares</span></div>
    <p id="invest-blocker"><strong>This is a research model.</strong> No live, execution-approved share-token vault is connected to this target. Deposits and signing are unavailable.</p>
    <button className={styles.secondaryButton} disabled aria-describedby="invest-blocker">Invest unavailable</button>
    <p className={styles.finePrint}>Connecting a wallet does not enable this model. No USDC is sent, no shares are issued, and no individual stock swaps are submitted.</p>
  </aside>;
}

export function PublishedTarget({ index }: { index: PublishedTradeIndex }) {
  return <section className={styles.targetPanel} aria-label="Published trade target">
    <span className={styles.modelBadge}>Published model · Not live holdings</span>
    <h2>Inside the index</h2><p>{index.definition.label}</p>
    <div className={styles.targetMeta}><span>Activity through {index.period}</span><span>Published {date(index.published_at)}</span><span>Version {index.version}</span></div>
    <div className={styles.modelNote}><Icon name="info" size={17} /><p>Weights reflect disclosed trade activity, including buys and sales—not current ownership. No live NAV or return is claimed.</p></div>
    <div className={styles.tableWrap} role="region" aria-label="Index target weights, scroll for mint addresses" tabIndex={0}>
      <table className={styles.table}><caption>{index.constituents.length} mapped names. Targets rounded to basis points.</caption><thead><tr><th scope="col">Asset</th><th scope="col">Target weight</th><th scope="col">Token issuer</th><th scope="col">Solana mint</th></tr></thead><tbody>{index.constituents.map((constituent) => <tr key={constituent.mint}><td><strong>{constituent.ticker}</strong></td><td className={styles.weight}>{(constituent.weight_bps / 100).toFixed(2)}%</td><td>{constituent.issuer}</td><td><code className={styles.mint}>{constituent.mint}</code></td></tr>)}</tbody></table>
    </div>
    <details className={styles.sourceDetails}><summary>How this target was built</summary><p>Activity-weighted, with at least one basis point per mapped name. Partial annual pages do not block publication; this target never repairs or replaces the annual book.</p><p>Excluded trade rows: {index.definition.excluded.length}</p><ul>{index.definition.excluded.map((excluded) => <li key={excluded.tradeId}>{excluded.ticker ?? excluded.name ?? "Unnamed disclosure"}: {excluded.reason}</li>)}</ul><p className={styles.targetVersion}>Immutable version: <code>{index.hash}</code></p></details>
  </section>;
}

export function FmpIndex({ hash, initialData }: { hash: string; initialData?: { index: PublishedTradeIndex } }) {
  const resource = useResource<{ index: PublishedTradeIndex }>(`/api/published-indexes/${encodeURIComponent(hash)}`, initialData);
  const directory = useResource<{ people: StoredPerson[] }>("/api/people");
  if (resource.error && !resource.data) return <PageError error={resource.error} retry={resource.reload} />;
  if (!resource.data) return <Skeleton cards={2} />;
  const { index } = resource.data;
  const person = directory.data?.people.find((entry) => entry.id === index.person_id);
  return <div className={styles.workspace}><Link className={styles.backLink} href={`/p/${index.person_id}`}><Icon name="arrow" size={16} style={{ transform: "rotate(180deg)" }} />Original book &amp; activity</Link><header className={styles.indexHero}><span className={styles.kicker}>The index desk</span><h1>{index.indexName ?? person?.indexName ?? "Published trade index"}</h1><p>See the weights. Check the sources. Know what you’re looking at.</p></header><div className={styles.indexLayout}><PublishedTarget index={index} /><InvestPanel /></div></div>;
}
