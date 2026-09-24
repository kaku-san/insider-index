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
import { navVaultEnabledFor } from "@/lib/frontend/vault-api";
import { indexContentFor } from "@/lib/frontend/index-content";
import { themeArtFor } from "@/lib/frontend/theme-art";
import { EcosystemLogos } from "./ecosystem-logos";
import { Icon } from "./social/icon";
import { PageError, StockIcon } from "./social/shared";
import styles from "./consumer-home.module.css";

type Filter = "all" | "people" | "themes";
type Sort = "live" | "featured" | "name" | "coverage" | "holdings";

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

type NavVaultDirectory = {
  indexes: { indexId: string; paused?: boolean }[];
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
  featured: boolean;
};

const FEATURED_INDEX_IDS = [
  "insiderindex-josh-gottheimer",
  "insiderindex-nancy-pelosi",
  "insiderindex-shri-thanedar",
  "insiderindex-lisa-mcclain",
  "insiderindex-julia-letlow",
  "idx-theme-mag7-caucus",
  "idx-theme-silicon-hill",
  "idx-theme-fresh-ink",
  "idx-theme-bipartisan-handshake",
  "idx-theme-house-heat",
] as const;
const featuredRank = new Map<string, number>(FEATURED_INDEX_IDS.map((id, rank) => [id, rank]));

function themeImage(id: string) {
  return themeArtFor(id)?.thumb ?? `/index-assets/themes/${id}-hero.png`;
}

function portraitForPerson(person: ResearchPerson) {
  return person.image ?? portraitFor(slugifyPerson(person.name));
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
    {row.image && !failed ? <Image src={row.image} alt="" fill sizes="52px" unoptimized={row.image.startsWith("http")} onError={() => setFailed(true)} /> : <span>{row.name.slice(0, 2)}</span>}
  </div>;
}

function IndexRow({ row }: { row: IndexRowData }) {
  const statusLabel = row.status;
  return <article className={styles.indexRow}>
    <Link href={row.href} className={styles.indexIdentity}>
      <IndexThumb row={row} />
      <div><strong>{row.name}</strong><span>{row.kind === "person" ? "Person index" : "Theme index"}</span></div>
    </Link>
    <Link href={row.href} className={styles.description}>{row.description}</Link>
    <div className={styles.holdingsCell}>
      <HoldingLogos tickers={row.tickers} count={row.holdings} />
      <span>{row.holdings == null ? "Loading holdings" : `${row.holdings} holdings`}</span>
    </div>
    <div className={styles.metricsCell}>
      <strong>{row.coverage == null ? row.coverageLabel : `${row.coverage.toFixed(row.coverage % 1 ? 1 : 0)}% ${row.coverageLabel}`}</strong>
      <span className={`${styles.status} ${row.status === "Research" ? styles.research : row.status === "Live" ? styles.live : styles.soon}`}>{statusLabel}</span>
    </div>
    <Link href={row.href} className={styles.rowCta}>{row.status === "Live" ? "Invest" : "View"} <Icon name="arrow" size={14} /></Link>
  </article>;
}

function vaultRow(
  index: PublicVaultDefinition,
  people: ResearchPerson[],
  themes: ThematicDirectory["indexes"],
  navLive: ReadonlySet<string> | null,
): IndexRowData {
  const person = people.find((item) => item.id === index.bioguideId || slugifyPerson(item.name) === index.personSlug);
  const theme = themes.find((item) => item.id === index.indexId);
  const status = navVaultEnabledFor(index.indexId) && navLive?.has(index.indexId) === true ? "Live" : "Research";
  const coverage = index.coverage.mappableByWeightBps == null ? null : index.coverage.mappableByWeightBps / 100;
  const content = indexContentFor(index.indexId);
  return {
    id: index.indexId,
    href: `/indexes/${index.indexId}`,
    kind: index.kind === "person" ? "person" : "theme",
    name: index.name,
    description: content?.cardHook || theme?.headline || (index.kind === "person"
      ? `Public holdings for ${person?.name ?? index.personSlug.replaceAll("-", " ")}.`
      : index.provenance.note ?? "A multi-member research basket built from public filings."),
    image: index.kind === "thematic" ? themeImage(index.indexId) : person ? portraitForPerson(person) : portraitFor(index.personSlug),
    holdings: index.legs.length,
    coverage,
    coverageLabel: index.kind === "thematic" ? "mapped" : "mapped",
    tickers: [...index.legs].sort((a, b) => b.targetWeightBps - a.targetWeightBps).map((item) => item.ticker),
    status,
    featured: featuredRank.has(index.indexId),
  };
}


export function FilingTape({ disclosures, error, loading = false, retry }: { disclosures: CopySignal[]; error: string | null; loading?: boolean; retry: () => void }) {
  if (error && !disclosures.length) return <PageError error={error} retry={retry} />;
  if (loading && !disclosures.length) return <div aria-busy="true" aria-label="Loading recent disclosures">Loading recent disclosures</div>;
  return <div>{disclosures.length ? `${disclosures.length} disclosures` : "Nothing new on the tape."}</div>;
}

export function ConsumerHome({ initialData, initialThemes, initialIndexes, initialNav }: {
  initialData?: PeopleDirectoryResponse;
  initialThemes?: ThematicDirectory;
  initialIndexes?: VaultIndexDirectory;
  initialNav?: NavVaultDirectory;
}) {
  const params = useSearchParams();
  const [filter, setFilter] = useState<Filter>("all");
  const [sort, setSort] = useState<Sort>("live");
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
  const navIds = definitions.map(index => index.indexId).join(",");
  const navResource = useResource<NavVaultDirectory>(navIds ? `/api/nav-vault?ids=${encodeURIComponent(navIds)}` : null, initialNav);
  const navLive = useMemo(() => navResource.data ? new Set(navResource.data.indexes.filter(item => !item.paused).map(item => item.indexId)) : null, [navResource.data]);
  const rows = useMemo(() => {
    let next = definitions.map((index) => vaultRow(index, people, themes, navLive));
    if (filter === "people") next = next.filter((row) => row.kind === "person");
    if (filter === "themes") next = next.filter((row) => row.kind === "theme");
    if (investableOnly) next = next.filter((row) => row.status === "Live");
    if (query) next = next.filter((row) => `${row.name} ${row.description} ${row.tickers.join(" ")}`.toLowerCase().includes(query));
    if (sort === "live") next.sort((a, b) => Number(b.status === "Live") - Number(a.status === "Live") || a.name.localeCompare(b.name));
    if (sort === "name") next.sort((a, b) => a.name.localeCompare(b.name));
    if (sort === "coverage") next.sort((a, b) => (b.coverage ?? 0) - (a.coverage ?? 0) || a.name.localeCompare(b.name));
    if (sort === "holdings") next.sort((a, b) => (b.holdings ?? 0) - (a.holdings ?? 0) || a.name.localeCompare(b.name));
    if (sort === "featured") next.sort((a, b) => (featuredRank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (featuredRank.get(b.id) ?? Number.MAX_SAFE_INTEGER) || a.name.localeCompare(b.name));
    return next;
  }, [definitions, filter, investableOnly, people, query, sort, themes, navLive]);
  const loading = !initialIndexes && indexResource.loading;
  const peopleCount = definitions.filter((index) => index.kind === "person").length;
  const themeCount = definitions.filter((index) => index.kind === "thematic").length;
  const total = definitions.length;

  return <div className={styles.home}>
    <section className={styles.hero}>
      <div className={styles.heroCopy}>
        <span className={styles.eyebrow}>PUBLIC FILINGS. OPEN BOOKS.</span>
        <h1>They disclose it.<br />We index it.</h1>
        <p className={styles.heroDescription}>The portfolios you’re curious about, without the paperwork. Explore indexes built from public financial disclosures.</p>
        <div className={styles.heroActions}><a href="#all-indexes-title" className={styles.heroPrimary}>Explore indexes <Icon name="arrow" size={16} /></a><Link href="/methodology" className={styles.heroSecondary}>How it works <Icon name="info" size={15} /></Link></div>
        <div className={styles.heroProof}><span><Icon name="file" size={15} />Public sources</span><span><Icon name="eye" size={15} />Transparent holdings</span><span><Icon name="wallet" size={15} />You approve trades</span></div>
        <span className={styles.catalogMeta}>{loading ? "Loading catalog…" : `${total} indexes · ${peopleCount} people · ${themeCount} themes`}</span>
      </div>
      <figure className={styles.editorialArt} aria-label="Editorial collage with Capitol architecture, paper textures and orange accents">
        <Image src="/index-assets/home/editorial-collage.webp" alt="" width={577} height={364} sizes="(max-width: 560px) 94vw, (max-width: 900px) 42vw, 520px" priority />
      </figure>
    </section>

    <section className={styles.tableSection} aria-labelledby="all-indexes-title">
      <div className={styles.tableHead}>
        <div><h2 id="all-indexes-title">Explore indexes <span className={styles.resultCount}>{rows.length}</span></h2></div>
        <div className={styles.utilityBar}>
          <div className={styles.segmented} aria-label="Index type filter">
            {([["all", "All"], ["people", "People"], ["themes", "Themes"]] as const).map(([value, label]) => <button type="button" key={value} className={filter === value ? styles.active : ""} onClick={() => setFilter(value)}>{label}</button>)}
          </div>
          <label className={styles.sortSelect}>Sort
            <select value={sort} onChange={(event) => setSort(event.target.value as Sort)}>
              <option value="live">Live first</option><option value="featured">Featured</option><option value="name">A–Z</option><option value="coverage">Coverage</option><option value="holdings">Holdings</option>
            </select>
          </label>
          <label className={styles.investToggle}><input type="checkbox" checked={investableOnly} onChange={(event) => setInvestableOnly(event.target.checked)} /><span>Investable only</span></label>
        </div>
      </div>
      <div className={styles.columnHead} aria-hidden="true">
        <span>Index</span><span>Description</span><span>Holdings</span><span>Coverage / status</span><span />
      </div>
      <div className={styles.tableBody}>
        {rows.map((row) => <IndexRow key={row.id} row={row} />)}
        {!loading && !rows.length ? <div className={styles.empty}><strong>No indexes match this view.</strong><span>{investableOnly ? "No indexes are open to invest yet." : indexResource.error ?? "Clear the filters or search to see the index catalog."}</span></div> : null}
        {loading ? <div className={styles.empty}><strong>Loading index catalog…</strong></div> : null}
      </div>
    </section>

    <EcosystemLogos />
  </div>;
}
