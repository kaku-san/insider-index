"use client";

import Link from "next/link";
import { useResource } from "@/lib/frontend/use-resource";
import type { ThematicIndexView } from "@/lib/thematic/views";
import { PageError, Skeleton, StockIcon } from "./social/shared";
import { Icon } from "./social/icon";
import { AllocationBreakdown } from "./allocation-breakdown";
import { companyNameFor } from "@/lib/frontend/company-logos";
import styles from "./consumer-index.module.css";

type Payload = { index: ThematicIndexView; storage: string };

export function ThematicIndexPage({ id, initialData }: { id: string; initialData?: Payload }) {
  const resource = useResource<Payload>(`/api/thematic-indexes/${encodeURIComponent(id)}`, initialData);
  if (resource.loading && !resource.data) return <Skeleton />;
  if (resource.error && !resource.data) return <PageError error={resource.error} retry={resource.reload} />;
  const index = resource.data?.index;
  if (!index) return null;

  const holdings = [...index.constituents].sort((a, b) => b.weight_bps - a.weight_bps);
  const max = Math.max(...holdings.map((h) => h.weight_bps), 1);
  const totalBps = holdings.reduce((sum, row) => sum + row.weight_bps, 0);

  return (
    <div className={styles.page}>
      <div className={styles.breadcrumb}>
        <Link href="/#themes">
          <Icon name="arrow" size={13} style={{ transform: "rotate(180deg)" }} />
          Thematic indexes
        </Link>
        <span>Research model</span>
      </div>

      <section className={styles.hero}>
        <div className={styles.portrait}>
          <span>{index.indexName.slice(0, 2)}</span>
          <b>THEME</b>
        </div>
        <div className={styles.heroCopy}>
          <span>{index.status} · {index.lane}</span>
          <h1>{index.indexName}</h1>
          <p>{index.tagline}</p>
          <div className={styles.meta}>
            <b>{holdings.length}</b>
            <span>mapped names</span>
            <i />
            <b>{index.members.length}</b>
            <span>members</span>
            <i />
            <span>{index.rebalance}</span>
          </div>
          <div className={styles.actions}>
            <Link className={styles.invest} href="/feed">
              Copy one print <Icon name="arrow" size={14} />
            </Link>
            <Link href="/#themes">All themes</Link>
          </div>
        </div>
        <aside className={styles.state}>
          <small>PRODUCT STATE</small>
          <strong>Research</strong>
          <p>
            Multi-member theme — not a celebrity clone. Basket Buy stays unavailable. Person trackers remain on
            individual profiles.
          </p>
          <span>{index.badge}</span>
        </aside>
      </section>

      <div className={styles.layout}>
        <main>
          <p style={{ color: "#697183", lineHeight: 1.5, fontSize: 13, margin: "0 0 16px", maxWidth: 720 }}>
            {index.narrative}
          </p>
          {holdings.length ? (
            <AllocationBreakdown
              title="Index allocation"
              subtitle={index.hook}
              items={holdings.map((h) => ({
                ticker: h.ticker,
                name: companyNameFor(h.ticker, h.issuer),
                weight: h.weight_bps / 10_000,
              }))}
            />
          ) : null}
          <section className={styles.weights}>
            <header>
              <div>
                <h2>Allocation</h2>
                <p>Published target weights — not a live wallet or vault NAV.</p>
              </div>
              <span>{(totalBps / 100).toFixed(0)}% mapped target</span>
            </header>
            {holdings.length ? (
              <div className={styles.rows}>
                {holdings.map((item, n) => (
                  <article className={styles.row} key={item.mint}>
                    <span>{String(n + 1).padStart(2, "0")}</span>
                    <StockIcon ticker={item.ticker} />
                    <div className={styles.ticker}>
                      <strong>{item.ticker}</strong>
                      <small>{companyNameFor(item.ticker, item.issuer)} · {item.issuer === "xstock" ? "xStock" : "Backpack"}</small>
                    </div>
                    <div className={styles.bar}>
                      <i style={{ width: `${Math.max(2, (item.weight_bps / max) * 100)}%` }} />
                    </div>
                    <b>{(item.weight_bps / 100).toFixed(item.weight_bps >= 1000 ? 1 : 2)}%</b>
                  </article>
                ))}
              </div>
            ) : (
              <div className={styles.empty}>No mapped constituents in this model.</div>
            )}
          </section>

          <section className={styles.details}>
            <div>
              <h3>How it was built</h3>
              <p>{index.rule}</p>
              <p><b>Hook</b> · {index.hook}</p>
              <p><b>Why it exists</b> · {index.whyItExists}</p>
              <p><b>Methodology</b> · <code>{index.methodology}</code></p>
            </div>
            <div>
              <h3>Members ({index.members.length})</h3>
              {index.members.slice(0, 12).map((m) => (
                <p key={m.slug}>
                  <b>{m.name}</b>
                  {[m.party, m.state].filter(Boolean).length
                    ? ` · ${[m.party, m.state].filter(Boolean).join(" · ")}`
                    : ""}
                </p>
              ))}
              {index.members.length > 12 ? <p>+{index.members.length - 12} more in the feed</p> : null}
            </div>
          </section>

          <section className={styles.details} style={{ marginTop: 16 }}>
            <div>
              <h3>Sources</h3>
              <p>{index.sourceLine}</p>
              {index.sources.websiteFooterBlock.slice(0, 4).map((line) => (
                <p key={line}>{line}</p>
              ))}
            </div>
            <div>
              <h3>Disclaimers</h3>
              {index.disclaimers.map((line) => (
                <p key={line}>{line}</p>
              ))}
            </div>
          </section>
        </main>

        <aside className={styles.side}>
          <span>RESEARCH MODEL</span>
          <h2>Theme, not a tip.</h2>
          <ol>
            <li>
              <b>1</b>
              <div>
                <strong>Public filings</strong>
                <span>House Clerk / Senate eFD via FMP + PelosiTracker context.</span>
              </div>
            </li>
            <li>
              <b>2</b>
              <div>
                <strong>Catalog gate</strong>
                <span>Only Solana-tradable names (xStocks / Backpack .US).</span>
              </div>
            </li>
            <li>
              <b>3</b>
              <div>
                <strong>Model weights</strong>
                <span>{totalBps.toLocaleString()} bps · no invented prices.</span>
              </div>
            </li>
            <li>
              <b>4</b>
              <div>
                <strong>Copy one print</strong>
                <span>Basket Buy stays off until native vault release.</span>
              </div>
            </li>
          </ol>
          <Link href="/feed" style={{ display: "block", textAlign: "center", textDecoration: "none" }}>
            <button type="button">Open the feed</button>
          </Link>
          <small>Index id <code>{index.id}</code> · basis <code>{index.basis}</code></small>
        </aside>
      </div>
    </div>
  );
}
