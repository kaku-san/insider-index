"use client";

import Link from "next/link";
import Image from "next/image";
import { useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useResource } from "@/lib/frontend/use-resource";
import { portraitFor } from "@/lib/fomo/portraits";
import { slugifyPerson } from "@/lib/frontend/research-format";
import type { PeopleDirectoryResponse, ResearchPerson } from "@/lib/frontend/research-contract";
import type { CopySignal } from "@/lib/disclosures/types";
import type { PublicVaultDefinition } from "@/lib/index-vaults/vault-definition-store";
import { publicIndexStatus } from "@/lib/frontend/vault-api";
import { Icon } from "./social/icon";
import { PageError, StockIcon } from "./social/shared";
import styles from "./consumer-home.module.css";

type Filter = "all" | "people" | "themes";
type Sort = "featured" | "name" | "coverage" | "holdings";

export type ThematicDirectory = {
  count: number;
  indexes: {
    id: string;
    name: string;
    headline: string;
    tagline: string;
    legs: number;
    members: number;
    top5: { ticker: string; weightBps: number }[];
    href: string;
  }[];
};

export type VaultIndexDirectory = {
  count: number;
  indexes: PublicVaultDefinition[];
  publicFundsEnabled: boolean;
  storage: string;
};

type IndexRowData = {
  id: string;
  href: string;
  kind: "person" | "theme";
  name: string;
  description: string;
  image: string | null;
  holdings: number | null;
  coverage: number | null;
  coverageLabel: string;
  tickers: string[];
  status: "Live" | "Coming soon" | "Research";
};

function themeImage(id: string) {
  return `/index-assets/themes/${id}-hero.png`;
}

function portraitForPerson(person: ResearchPerson) {
  return person.image ?? portraitFor(slugifyPerson(person.name));
}

function SparklinePending() {
  return <div className={styles.sparkPending} aria-label="Performance series not available yet">
    <svg viewBox="0 0 108 34" role="img" aria-hidden="true">
      <path d="M2 22 C18 22, 24 15, 38 18 S58 23, 70 16 S91 13, 106 17" />
    </svg>
    <span>Awaiting series</span>
  </div>;
}

function HoldingLogos({ tickers, count }: { tickers: string[]; count: number | null }) {
  const top = tickers.slice(0, 4);
  const overflow = count == null ? 0 : Math.max(count - top.length, 0);
  return <div className={styles.holdingLogos}>
    {top.map((ticker) => <StockIcon key={ticker} ticker={ticker} size="sm" />)}
    {overflow > 0 ? <span className={styles.logoOverflow}>+{overflow}</span> : null}
  </div>;
}

function IndexThumb({ row }: { row: IndexRowData }) {
  const [failed, setFailed] = useState(false);
  return <div className={`${styles.thumb} ${row.kind === "theme" ? styles.themeThumb : ""}`}>
    {row.image && !failed ? <Image src={row.image} alt="" fill sizes="46px" unoptimized={row.image.startsWith("http")} onError={() => setFailed(true)} /> : <span>{row.name.slice(0, 2)}</span>}
  </div>;
}

function IndexRow({ row }: { row: IndexRowData }) {
  return <article className={styles.indexRow}>
    <Link href={row.href} className={styles.indexIdentity}>
      <IndexThumb row={row} />
      <div><strong>{row.name}</strong><span>{row.kind === "person" ? "Person index" : "Theme index"}</span></div>
    </Link>
    <Link href={row.href} className={styles.description}>{row.description}</Link>
    <div className={styles.returnCell}><strong>—</strong><span>1Y return</span></div>
    <SparklinePending />
    <div className={styles.holdingsCell}>
      <HoldingLogos tickers={row.tickers} count={row.holdings} />
      <span>{row.holdings == null ? "Loading holdings" : `${row.holdings} holdings`}</span>
    </div>
    <div className={styles.metricsCell}>
      <strong>{row.coverage == null ? row.coverageLabel : `${row.coverage.toFixed(row.coverage % 1 ? 1 : 0)}% ${row.coverageLabel}`}</strong>
      <span className={`${styles.status} ${row.status === "Research" ? styles.research : row.status === "Live" ? styles.live : styles.soon}`}>{row.status}</span>
    </div>
    <Link href={row.href} className={styles.rowCta}>{row.status === "Live" ? "Invest" : "View"} <Icon name="arrow" size={14} /></Link>
  </article>;
}

function vaultRow(
  index: PublicVaultDefinition,
  people: ResearchPerson[],
  themes: ThematicDirectory["indexes"],
  publicFundsEnabled: boolean,
): IndexRowData {
  const person = people.find((item) => item.id === index.bioguideId || slugifyPerson(item.name) === index.personSlug);
  const theme = themes.find((item) => item.id === index.indexId);
  const status = publicIndexStatus({
    vaultAddress: index.vaultAddress,
    shareMint: index.shareMint,
    network: index.network,
    depositsEnabled: index.depositsEnabled,
    publicFundsEnabled,
  });
  const coverage = (index.coverage.mappableByWeightBps ?? 0) / 100;
  return {
    id: index.indexId,
    href: `/indexes/${index.indexId}`,
    kind: index.kind === "person" ? "person" : "theme",
    name: index.name,
    description: theme?.headline || (index.kind === "person"
      ? `Public holdings for ${person?.name ?? index.personSlug.replaceAll("-", " ")}.`
      : index.provenance.note ?? "A multi-member research basket built from public filings."),
    image: index.kind === "thematic" ? themeImage(index.indexId) : person ? portraitForPerson(person) : portraitFor(index.personSlug),
    holdings: index.legs.length,
    coverage,
    coverageLabel: index.kind === "thematic" ? "mapped" : "mapped",
    tickers: index.legs.slice(0, 4).map((item) => item.ticker),
    status,
  };
}

const infra = [
  ["Solana", "Network"], ["Jupiter", "Routing"], ["Privy", "Wallet"], ["xStocks", "Tokenized stocks"],
  ["Backpack", "Stock tokens"], ["Symmetry", "Index vault"], ["FMP", "Market data"],
] as const;

export function FilingTape({ disclosures, error, loading = false, retry }: { disclosures: CopySignal[]; error: string | null; loading?: boolean; retry: () => void }) {
  if (error && !disclosures.length) return <PageError error={error} retry={retry} />;
  if (loading && !disclosures.length) return <div aria-busy="true" aria-label="Loading recent disclosures">Loading recent disclosures</div>;
  return <div>{disclosures.length ? `${disclosures.length} disclosures` : "Nothing new on the tape."}</div>;
}

export function ConsumerHome({ initialData, initialThemes, initialIndexes }: {
  initialData?: PeopleDirectoryResponse;
  initialThemes?: ThematicDirectory;
  initialIndexes?: VaultIndexDirectory;
}) {
  const params = useSearchParams();
  const [filter, setFilter] = useState<Filter>("all");
  const [sort, setSort] = useState<Sort>("featured");
  const [investableOnly, setInvestableOnly] = useState(false);
  const peopleResource = useResource<PeopleDirectoryResponse>("/api/people", initialData);
  const themeResource = useResource<ThematicDirectory>("/api/thematic-indexes", initialThemes);
  const indexResource = useResource<VaultIndexDirectory>("/api/vault-indexes", initialIndexes);
  const query = (params.get("q") ?? "").trim().toLowerCase();
  const people = useMemo(() => peopleResource.data?.people ?? [], [peopleResource.data]);
  const themes = useMemo(() => themeResource.data?.indexes ?? [], [themeResource.data]);
  const definitions = useMemo(
    () => (indexResource.data?.indexes ?? []).filter((index) => index.weightBasis === "annual-holding-value-midpoint" || index.weightBasis === "thematic-multi-member-value"),
    [indexResource.data],
  );
  const rows = useMemo(() => {
    let next = definitions.map((index) => vaultRow(index, people, themes, indexResource.data?.publicFundsEnabled ?? false));
    if (filter === "people") next = next.filter((row) => row.kind === "person");
    if (filter === "themes") next = next.filter((row) => row.kind === "theme");
    if (investableOnly) next = next.filter((row) => row.status === "Live");
    if (query) next = next.filter((row) => `${row.name} ${row.description} ${row.tickers.join(" ")}`.toLowerCase().includes(query));
    if (sort === "name") next.sort((a, b) => a.name.localeCompare(b.name));
    if (sort === "coverage") next.sort((a, b) => (b.coverage ?? 0) - (a.coverage ?? 0) || a.name.localeCompare(b.name));
    if (sort === "holdings") next.sort((a, b) => (b.holdings ?? 0) - (a.holdings ?? 0) || a.name.localeCompare(b.name));
    if (sort === "featured") next.sort((a, b) => Number(a.id !== "insiderindex-nancy-pelosi") - Number(b.id !== "insiderindex-nancy-pelosi") || Number(a.kind === "theme") - Number(b.kind === "theme") || a.name.localeCompare(b.name));
    return next;
  }, [definitions, filter, indexResource.data?.publicFundsEnabled, investableOnly, people, query, sort, themes]);
  const loading = !initialIndexes && indexResource.loading;
  const peopleCount = definitions.filter((index) => index.kind === "person").length;
  const themeCount = definitions.filter((index) => index.kind === "thematic").length;
  const total = definitions.length;

  return <div className={styles.home}>
    <section className={styles.hero}>
      <div>
        <span className={styles.eyebrow}>PUBLIC-MARKET INDEXES</span>
        <h1>They disclose it.<br />We index it.</h1>
        <p>Public filings rebuilt into clean, inspectable indexes — with holdings, mapping coverage and funding status in one place.</p>
      </div>
      <div className={styles.heroMeta}>
        <strong>{total || 20}</strong><span>indexes</span><i />
        <strong>{peopleCount || 10}</strong><span>people</span><i />
        <strong>{themeCount || 10}</strong><span>themes</span>
      </div>
    </section>

    <section className={styles.tableSection} aria-labelledby="all-indexes-title">
      <div className={styles.tableHead}>
        <div><span className={styles.eyebrow}>ALL INDEXES</span><h2 id="all-indexes-title">Pick the index. See the book.</h2></div>
        <div className={styles.utilityBar}>
          <div className={styles.segmented} aria-label="Index type filter">
            {([["all", "All"], ["people", "People"], ["themes", "Themes"]] as const).map(([value, label]) => <button type="button" key={value} className={filter === value ? styles.active : ""} onClick={() => setFilter(value)}>{label}</button>)}
          </div>
          <label className={styles.sortSelect}>Sort
            <select value={sort} onChange={(event) => setSort(event.target.value as Sort)}>
              <option value="featured">Featured</option><option value="name">A–Z</option><option value="coverage">Coverage</option><option value="holdings">Holdings</option>
            </select>
          </label>
          <label className={styles.investToggle}><input type="checkbox" checked={investableOnly} onChange={(event) => setInvestableOnly(event.target.checked)} /><span>Investable only</span></label>
        </div>
      </div>
      <div className={styles.columnHead} aria-hidden="true">
        <span>Index</span><span>Description</span><span>Return</span><span>Performance</span><span>Holdings</span><span>Metrics</span><span />
      </div>
      <div className={styles.tableBody}>
        {rows.map((row) => <IndexRow key={row.id} row={row} />)}
        {!loading && !rows.length ? <div className={styles.empty}><strong>No indexes match this view.</strong><span>{investableOnly ? "No indexes are open to invest yet." : indexResource.error ?? "Clear the filters or search to see the index catalog."}</span></div> : null}
        {loading ? <div className={styles.empty}><strong>Loading index catalog…</strong></div> : null}
      </div>
      <p className={styles.performanceNote}>Return and performance stay blank until InsiderIndex has a verified dated price series. We do not invent alpha.</p>
    </section>

    <section className={styles.solanaSection}>
      <div className={styles.solanaCopy}><span className={styles.eyebrow}>INFRASTRUCTURE</span><h2>Built on Solana.</h2><p>Wallet, routing, tokenized-stock and native index infrastructure behind InsiderIndex.</p></div>
      <div className={styles.infraGrid}>{infra.map(([name, note]) => <div className={styles.infraMark} key={name}><b>{name.slice(0, 1)}</b><div><strong>{name}</strong><span>{note}</span></div></div>)}</div>
    </section>
  </div>;
}
