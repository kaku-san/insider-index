/**
 * Derive the 20 InsiderIndex vault definitions from the committed FMP-holdings bucket and write the
 * all-20 dry-run initialisation report. No signing, no broadcast, no keeper key.
 *
 *   node --experimental-strip-types scripts/map-top20-index-vaults.mts [--live] [--publish]
 *
 * --live    resolve against the live Solana catalog (falls back to the committed snapshot);
 *           default uses the snapshot so the report is reproducible offline.
 * --publish upsert the definitions into Supabase (needs service env). Default is dry-run only.
 *
 * Pool evidence is pluggable: until the person-pages task's raydium-pools-mainnet lands, the pending
 * source reports every mint as unobserved, so creatable-structure vaults sit at WAIT_POOL_EVIDENCE.
 */
import { createClient } from "@supabase/supabase-js";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSolanaCatalog, snapshotCatalog } from "../src/lib/venues/solana-catalog.ts";
import { PENDING_POOL_SOURCE, type PoolEvidenceSource } from "../src/lib/index-vaults/pool-evidence.ts";
import { deriveAllPersonIndexes, toPersonBook } from "../src/lib/index-vaults/person-index-source.ts";
import type { PersonIndexDefinition } from "../src/lib/index-vaults/person-index-map.ts";
import { buildVaultDefinitionDocument, definitionForDb, publishVaultDefinitions } from "../src/lib/index-vaults/vault-definition-store.ts";

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
const poolSource: PoolEvidenceSource = PENDING_POOL_SOURCE;
const definitions = deriveAllPersonIndexes(books, catalog, poolSource);

const source = { zip: manifest.sourceZip ?? null, sha256: manifest.sourceSha256 ?? null, generatedAt: new Date().toISOString() };
const document = buildVaultDefinitionDocument(definitions, source);

function summary(def: PersonIndexDefinition) {
  const db = definitionForDb(def) as { vaultLegs: unknown[]; cost: { networkBudgetLamports: string } };
  return {
    slug: def.slug,
    indexId: def.indexId,
    symbol: def.symbol,
    status: def.status,
    bookSource: def.provenance.bookSource,
    weightBasis: def.weightBasis,
    mappedLegs: def.coverage.mappedLegCount,
    vaultReadyLegs: def.coverage.vaultReadyLegCount,
    mappableByWeightBps: def.coverage.mappableByWeightBps,
    unmappedByWeightBps: def.coverage.unmappedByWeightBps,
    blockedReasons: def.blockedReasons,
    networkBudgetLamports: db.cost.networkBudgetLamports,
  };
}

const rows = definitions.map(summary);
const byStatus = (s: string) => rows.filter((r) => r.status === s);

const report = {
  generatedAt: source.generatedAt,
  source,
  poolEvidence: { source: poolSource.source, fetchedAt: poolSource.fetchedAt, note: "Pending raydium-pools-mainnet; catalog mapping is complete, pool readiness is not." },
  catalogSource: live ? "live-or-snapshot" : "snapshot",
  counts: {
    total: rows.length,
    creatable: byStatus("CREATABLE").length,
    waitPoolEvidence: byStatus("WAIT_POOL_EVIDENCE").length,
    blocked: byStatus("BLOCKED").length,
  },
  people: rows,
};

const outDir = join(repoRoot, "evidence/vaults");
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "top20-index-map-dry-run.json"), JSON.stringify(report, null, 2) + "\n");

function md(): string {
  const lines: string[] = [];
  lines.push("# Top-20 InsiderIndex vault-init dry-run", "");
  lines.push(`Source: \`${source.zip}\` (sha256 \`${source.sha256}\`).`);
  lines.push(`Pool evidence: \`${poolSource.source}\` — ${report.poolEvidence.note}`);
  lines.push(`Catalog: ${report.catalogSource}. No signing, no broadcast, no keeper key.`, "");
  lines.push(`- Creatable: **${report.counts.creatable}**`);
  lines.push(`- Awaiting pool evidence (structure ready): **${report.counts.waitPoolEvidence}**`);
  lines.push(`- Blocked: **${report.counts.blocked}**`, "");
  lines.push("| Person | Index | Status | Book | Mapped legs | Vault-ready | Mappable bps | Unmapped bps | Blocked | Est. lamports |");
  lines.push("|---|---|---|---|--:|--:|--:|--:|---|--:|");
  for (const r of rows) {
    lines.push(`| ${r.slug} | ${r.symbol} | ${r.status} | ${r.bookSource ?? "-"} | ${r.mappedLegs} | ${r.vaultReadyLegs} | ${r.mappableByWeightBps} | ${r.unmappedByWeightBps} | ${r.blockedReasons.join("; ") || "-"} | ${r.networkBudgetLamports} |`);
  }
  lines.push("", "Weights renormalise across mapped legs only; the unmapped share by weight is disclosed above.",
    "Transaction-derived books carry no weights and are blocked. Cost is an estimate, not a quote.", "");
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

console.log(JSON.stringify({ mode: publish ? "published" : "dry-run", counts: report.counts, published, out: outDir }, null, 1));
