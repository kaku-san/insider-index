/**
 * Derive ALL 20 published InsiderIndex vault definitions and write the all-20 dry-run report:
 *   - 10 person books from the committed FMP-holdings bucket, and
 *   - 10 constructed multi-member thematic research baskets from the merged research feed.
 * Both kinds run through the SAME derivation, pool-readiness and vault-init path. No signing, no
 * broadcast, no keeper key.
 *
 *   node --experimental-strip-types scripts/map-top20-index-vaults.mts [--live] [--publish]
 *
 * --live    resolve against the live Solana catalog (falls back to the committed snapshot);
 *           default uses the snapshot so the report is reproducible offline.
 * --publish upsert the definitions into Supabase (needs service env). Default is dry-run only.
 *
 * Pool evidence is the landed `raydium-pools-mainnet` snapshot (owner of pool observations). Legs
 * carry a Symmetry-usable oracle only where a real, tradable mainnet USDC Raydium pool was observed;
 * thin or absent liquidity is a not-ready leg and drops out of tradable coverage. The snapshot must
 * be fresh: a stale one fails closed rather than being used as if freshly observed. Creation is
 * cheap and ungated; deposits are a SEPARATE, closed-by-default gate driven by tradable coverage.
 */
import { createClient } from "@supabase/supabase-js";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSolanaCatalog, snapshotCatalog } from "../src/lib/venues/solana-catalog.ts";
import { poolSourceFromReadiness, type PoolEvidenceSource } from "../src/lib/index-vaults/pool-evidence.ts";
import { assertFreshPoolSnapshot, mainnetRaydiumPoolSnapshot, poolReadiness } from "../src/lib/index-vaults/raydium-pools-mainnet.ts";
import { deriveAllPersonIndexes, toPersonBook } from "../src/lib/index-vaults/person-index-source.ts";
import { deriveAllThematicIndexes } from "../src/lib/index-vaults/thematic-index-map.ts";
import { MIN_MAPPED_LEGS, WEIGHTABLE_BASES, type PersonIndexDefinition } from "../src/lib/index-vaults/person-index-map.ts";
import { buildVaultDefinitionDocument, definitionForDb, publishVaultDefinitions } from "../src/lib/index-vaults/vault-definition-store.ts";

// Report-editorial coverage bars (not a re-weighting; they only classify the honest tradable
// coverage the mapping computes). A vault is structurally creatable at >= MIN_MAPPED_LEGS tradable
// legs; these bars judge whether that vault represents the book well enough to publish.
const PUBLISH_MIN_TRADABLE_BPS = 5000; // >= 50% of the book tradable: publish without heavy caveat.
const MISREPRESENT_TRADABLE_BPS = 2500; // < 25% tradable: a vault would misrepresent the book.
const LAMPORTS_PER_SOL = 1_000_000_000;
const solStr = (lamports: number) => (lamports / LAMPORTS_PER_SOL).toFixed(6);

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bucketDir = join(repoRoot, "data/insiderindex-source-buckets/pelositracker-fmp-latest-top20");
const live = process.argv.includes("--live");
const publish = process.argv.includes("--publish");

const manifest = JSON.parse(readFileSync(join(bucketDir, "MANIFEST.json"), "utf8"));
const books = readdirSync(join(bucketDir, "holdings"))
  .filter((f) => f.endsWith(".json"))
  .sort()
  .map((f) => toPersonBook(JSON.parse(readFileSync(join(bucketDir, "holdings", f), "utf8"))));

const catalog = live ? await loadSolanaCatalog() : snapshotCatalog();
// Consume the landed live-Raydium snapshot. Fail closed on a stale snapshot: the creatable decision
// must never rest on pool evidence presented as fresher than it is. The SAME source measures the
// thematic baskets, so their tradable coverage is real, not the old pending 0.
const snapshot = mainnetRaydiumPoolSnapshot();
const now = new Date();
const freshness = assertFreshPoolSnapshot(snapshot.fetchedAt, now);
const poolSource: PoolEvidenceSource = poolSourceFromReadiness(
  (mint) => poolReadiness(mint, snapshot.pools),
  { fetchedAt: snapshot.fetchedAt, source: snapshot.source },
);
const personDefs = deriveAllPersonIndexes(books, catalog, poolSource);
const thematicDefs = deriveAllThematicIndexes(catalog, poolSource);
const definitions = [...personDefs, ...thematicDefs];

const source = { zip: manifest.sourceZip ?? null, sha256: manifest.sourceSha256 ?? null, generatedAt: new Date().toISOString() };
const document = buildVaultDefinitionDocument(definitions, source);

type Verdict = "creatable-now" | "creatable-below-publish-bar" | "creatable-misrepresents" | "wait-pool-evidence" | "blocked";

function verdictFor(def: PersonIndexDefinition): { verdict: Verdict; detail: string } {
  const cov = def.coverage;
  if (def.status === "BLOCKED") return { verdict: "blocked", detail: def.blockedReasons.join("; ") || "blocked" };
  if (def.status === "WAIT_POOL_EVIDENCE") {
    return { verdict: "wait-pool-evidence", detail: `only ${cov.vaultReadyLegCount} of ${cov.mappedLegCount} mapped legs are pool-ready (need >= ${MIN_MAPPED_LEGS})` };
  }
  // CREATABLE: >= MIN_MAPPED_LEGS tradable legs. Judge the tradable coverage honestly.
  if (cov.tradableByWeightBps < MISREPRESENT_TRADABLE_BPS) {
    return { verdict: "creatable-misrepresents", detail: `tradable coverage ${(cov.tradableByWeightBps / 100).toFixed(1)}% < ${(MISREPRESENT_TRADABLE_BPS / 100).toFixed(0)}%: a vault would misrepresent the book` };
  }
  if (cov.tradableByWeightBps < PUBLISH_MIN_TRADABLE_BPS) {
    return { verdict: "creatable-below-publish-bar", detail: `tradable coverage ${(cov.tradableByWeightBps / 100).toFixed(1)}% below the ${(PUBLISH_MIN_TRADABLE_BPS / 100).toFixed(0)}% publish bar` };
  }
  return { verdict: "creatable-now", detail: `tradable coverage ${(cov.tradableByWeightBps / 100).toFixed(1)}%` };
}

function summary(def: PersonIndexDefinition) {
  const db = definitionForDb(def) as { vaultLegs: unknown[]; cost: { networkBudgetLamports: string } };
  const { verdict, detail } = verdictFor(def);
  const lamports = Number(db.cost.networkBudgetLamports);
  return {
    kind: def.kind,
    slug: def.slug,
    indexId: def.indexId,
    symbol: def.symbol,
    status: def.status,
    verdict,
    verdictDetail: detail,
    // Creation is separate from deposit-ready: a vault can be created cheaply yet keep deposits
    // closed until every mapped leg has an observed tradable pool.
    creatable: def.structurallyCreatable,
    depositsEnabled: def.depositsEnabled,
    depositReason: def.depositReason,
    bookSource: def.provenance.bookSource,
    weightBasis: def.weightBasis,
    mappedLegs: def.coverage.mappedLegCount,
    poolReadyLegs: def.coverage.vaultReadyLegCount,
    // Catalog coverage: book weight that maps to a Solana mint (whole-book basis).
    catalogCoverageBps: def.coverage.mappableByWeightBps,
    // Tradable coverage: book weight behind a real, tradable pool (whole-book basis, comparable).
    tradableCoverageBps: def.coverage.tradableByWeightBps,
    // Book weight that maps to a mint but has no usable pool: catalog - tradable.
    mappedButUntradableBps: def.coverage.mappableByWeightBps - def.coverage.tradableByWeightBps,
    unmappedByWeightBps: def.coverage.unmappedByWeightBps,
    // Tradable share of the renormalised mapped-leg weights (mapped-only basis).
    tradableOfMappedBps: def.coverage.poolReadyOfMappedBps,
    misrepresentsBook: verdict === "creatable-misrepresents",
    blockedReasons: def.blockedReasons,
    networkBudgetLamports: db.cost.networkBudgetLamports,
    networkBudgetSol: solStr(lamports),
  };
}

const allRows = definitions.map(summary);
// The 20 PUBLISHED indexes the captain means are the weightable ones: the 10 individual person
// books that map to a real book plus the 10 constructed thematic baskets. Non-weightable people
// (transaction-derived or no-ticker annual books) yield no index and are surfaced separately.
const isWeightable = (basis: string) => (WEIGHTABLE_BASES as readonly string[]).includes(basis);
const rows = allRows.filter((r) => isWeightable(r.weightBasis));
const notPublishable = allRows.filter((r) => !isWeightable(r.weightBasis));
const byStatus = (s: string) => rows.filter((r) => r.status === s);
const byVerdict = (v: Verdict) => rows.filter((r) => r.verdict === v);
const totalLamports = rows.reduce((s, r) => s + Number(r.networkBudgetLamports), 0);

// Thematic indexes ranked by real (whole-book) tradable coverage — the honest basis for choosing
// which baskets to fund. Ties break to catalog coverage, then id, for a stable order.
const thematicByTradable = rows
  .filter((r) => r.kind === "thematic")
  .sort((a, b) => b.tradableCoverageBps - a.tradableCoverageBps || b.catalogCoverageBps - a.catalogCoverageBps || a.indexId.localeCompare(b.indexId));

const report = {
  generatedAt: source.generatedAt,
  source,
  poolEvidence: {
    source: poolSource.source,
    fetchedAt: poolSource.fetchedAt,
    pools: snapshot.pools.length,
    unresolved: snapshot.unresolved.length,
    freshness: { ageHours: Number((freshness.ageMs / 3_600_000).toFixed(2)), maxAgeHours: freshness.maxAgeMs / 3_600_000, stale: freshness.stale },
    note: "Live Raydium snapshot. A leg is pool-ready only with a real, tradable USDC Raydium CLMM/CPMM pool above the TVL floor; thin/absent liquidity is a not-ready leg and drops out of tradable coverage.",
  },
  publishBars: { publishMinTradableBps: PUBLISH_MIN_TRADABLE_BPS, misrepresentTradableBps: MISREPRESENT_TRADABLE_BPS },
  catalogSource: live ? "live-or-snapshot" : "snapshot",
  counts: {
    publishedIndexes: rows.length,
    person: rows.filter((r) => r.kind === "person").length,
    thematic: rows.filter((r) => r.kind === "thematic").length,
    creatableToday: byStatus("CREATABLE").length,
    creatableNow: byVerdict("creatable-now").length,
    creatableBelowPublishBar: byVerdict("creatable-below-publish-bar").length,
    creatableButMisrepresents: byVerdict("creatable-misrepresents").length,
    depositReady: rows.filter((r) => r.depositsEnabled).length,
    waitPoolEvidence: byStatus("WAIT_POOL_EVIDENCE").length,
    blocked: byStatus("BLOCKED").length,
    notPublishablePeople: notPublishable.length,
  },
  totalCreationCost: { lamports: String(totalLamports), sol: solStr(totalLamports) },
  releaseGate: "Deposits are additionally gated by VAULT_RELEASE.publicFundsEnabled (currently off).",
  thematicRankedByTradableCoverage: thematicByTradable.map((r) => ({ indexId: r.indexId, symbol: r.symbol, tradableCoverageBps: r.tradableCoverageBps, catalogCoverageBps: r.catalogCoverageBps, poolReadyLegs: r.poolReadyLegs, mappedLegs: r.mappedLegs, verdict: r.verdict })),
  vaults: rows,
  notPublishablePeople: notPublishable,
};

const outDir = join(repoRoot, "evidence/vaults");
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "top20-index-map-dry-run.json"), JSON.stringify(report, null, 2) + "\n");

const pct = (bps: number) => `${(bps / 100).toFixed(1)}%`;
const VERDICT_LABEL: Record<Verdict, string> = {
  "creatable-now": "creatable now",
  "creatable-below-publish-bar": "creatable — below publish bar",
  "creatable-misrepresents": "creatable — WOULD MISREPRESENT (do not publish)",
  "wait-pool-evidence": "blocked — insufficient tradable liquidity",
  blocked: "blocked",
};

function md(): string {
  const lines: string[] = [];
  lines.push("# All-20 InsiderIndex vault-init dry-run", "");
  lines.push(`Source: \`${source.zip}\` (sha256 \`${source.sha256}\`) for the 10 person books; the 10 thematic baskets come from the merged research feed.`);
  lines.push(`Pool evidence: \`${poolSource.source}\` observed ${poolSource.fetchedAt} (${report.poolEvidence.freshness.ageHours}h old, ${report.poolEvidence.pools} pools / ${report.poolEvidence.unresolved} unresolved).`);
  lines.push(report.poolEvidence.note);
  lines.push(`Publish bars: tradable >= ${pct(PUBLISH_MIN_TRADABLE_BPS)} publishes without caveat; tradable < ${pct(MISREPRESENT_TRADABLE_BPS)} would misrepresent the book.`);
  lines.push(`Catalog: ${report.catalogSource}. No signing, no broadcast, no keeper key.`, "");
  lines.push(`- Published indexes: **${report.counts.publishedIndexes}** (person **${report.counts.person}**, thematic **${report.counts.thematic}**)`);
  lines.push(`- Creatable now (>= ${pct(PUBLISH_MIN_TRADABLE_BPS)} tradable): **${report.counts.creatableNow}**`);
  lines.push(`- Creatable but below publish bar: **${report.counts.creatableBelowPublishBar}**`);
  lines.push(`- Creatable but would misrepresent the book: **${report.counts.creatableButMisrepresents}**`);
  lines.push(`- Deposit-ready (per-vault gate; still release-gated): **${report.counts.depositReady}**`);
  lines.push(`- Blocked — insufficient tradable liquidity (structure ready): **${report.counts.waitPoolEvidence}**`);
  lines.push(`- Blocked — no mappable book: **${report.counts.blocked}**`);
  lines.push(`- Estimated total creation cost for all ${report.counts.publishedIndexes}: **${report.totalCreationCost.sol} SOL** (${report.totalCreationCost.lamports} lamports)`);
  lines.push(`- ${report.releaseGate}`, "");
  lines.push("Catalog coverage = book weight that maps to a Solana mint. Tradable coverage = book weight behind a real, tradable pool (same whole-book basis). The gap is mapped-but-untradable weight, never re-weighted around.", "");
  lines.push("| Kind | Index | Symbol | Verdict | Deposit-ready | Book | Mapped | Pool-ready | Catalog cov | Tradable cov | Untradable | Est. SOL |");
  lines.push("|---|---|---|---|:--:|---|--:|--:|--:|--:|--:|--:|");
  for (const r of rows) {
    lines.push(`| ${r.kind} | ${r.slug} | ${r.symbol} | ${VERDICT_LABEL[r.verdict]} | ${r.depositsEnabled ? "yes" : "no"} | ${r.bookSource ?? "-"} | ${r.mappedLegs} | ${r.poolReadyLegs} | ${pct(r.catalogCoverageBps)} | ${pct(r.tradableCoverageBps)} | ${pct(r.mappedButUntradableBps)} | ${r.networkBudgetSol} |`);
  }
  lines.push("", `**Total to create all ${report.counts.publishedIndexes}: ${report.totalCreationCost.sol} SOL** (estimate, not a quote).`);
  const pelosi = rows.find((r) => r.slug === "nancy-pelosi");
  if (pelosi) lines.push(`Pilot person index nancy-pelosi (${pelosi.mappedLegs} mapped legs): **${pelosi.networkBudgetSol} SOL** to create.`);
  lines.push("", "Thematic baskets ranked by real tradable coverage (the honest basis for choosing which to fund):");
  lines.push("| Rank | Thematic index | Tradable cov | Catalog cov | Pool-ready / mapped | Verdict |");
  lines.push("|--:|---|--:|--:|--:|---|");
  thematicByTradable.forEach((r, i) => lines.push(`| ${i + 1} | ${r.slug} | ${pct(r.tradableCoverageBps)} | ${pct(r.catalogCoverageBps)} | ${r.poolReadyLegs} / ${r.mappedLegs} | ${VERDICT_LABEL[r.verdict]} |`));
  const misrep = rows.filter((r) => r.misrepresentsBook);
  if (misrep.length) lines.push("", `Do not publish (tradable coverage too low, would misrepresent the book): ${misrep.map((r) => r.slug).join(", ")}.`);
  lines.push("", "Weights renormalise across mapped legs only; the unmapped share by weight is disclosed above.",
    "Creation is cheap and ungated; deposits stay CLOSED until every mapped leg has an observed tradable pool, and the release flag governs going live.",
    "A not-ready leg (thin/absent pool) never contributes to tradable coverage. Transaction-derived books carry no weights and are blocked. Cost is an estimate, not a quote.", "");
  if (notPublishable.length) {
    lines.push(`Not publishable as an index (${notPublishable.length} people, no weightable book): ` +
      notPublishable.map((r) => `${r.slug} (${r.blockedReasons.join("; ") || r.weightBasis})`).join(", ") + ".", "");
  }
  return lines.join("\n");
}
writeFileSync(join(outDir, "top20-index-map-dry-run.md"), md());

let published: { total: number; changed: number } | null = null;
if (publish) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase service configuration required for --publish");
  const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  published = await publishVaultDefinitions(db, document);
}

console.log(JSON.stringify({ mode: publish ? "published" : "dry-run", counts: report.counts, thematicTop: report.thematicRankedByTradableCoverage.slice(0, 3), published, out: outDir }, null, 1));
