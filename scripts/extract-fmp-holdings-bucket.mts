/**
 * Extract the InsiderIndex FMP-holdings source bucket from the captain's top-20 drop.
 *
 * The captain bundle (pelositracker-fmp-latest-top20.zip) carries FMP *annual holdings* — the
 * authoritative book for vault-leg mapping — but weighs ~36 MB with performance/trade tapes that
 * never enter a weight. This tool keeps the holdings verbatim (never truncated, unlike the
 * convenience brief) and drops the heavy tapes, so the committed bucket stays reviewable while the
 * derivation remains re-derivable and versioned by the source `sha256`.
 *
 * Usage: node --experimental-strip-types scripts/extract-fmp-holdings-bucket.mts \
 *          --source <unzipped-bundle-dir> --sha <source-zip-sha256> [--out <bucket-dir>]
 *
 * `--source` is the directory of the unzipped drop (profiles/, fmp-raw-latest/,
 * completeness-summary.json, README.md). Nothing is fetched; this reads local files only.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = arg("source");
if (!source) throw new Error("--source <unzipped-bundle-dir> is required");
const sourceSha = arg("sha") ?? null;
const outDir = arg("out") ?? join(repoRoot, "data/insiderindex-source-buckets/pelositracker-fmp-latest-top20");

const sourceDir = resolve(source);
const completeness = JSON.parse(readFileSync(join(sourceDir, "completeness-summary.json"), "utf8"));
const readme = readFileSync(join(sourceDir, "README.md"), "utf8");
const summaryBySlug = new Map<string, Record<string, unknown>>(
  (completeness.summary as Record<string, unknown>[]).map((row) => [String(row.slug), row]),
);

/** Only the fields the leg mapping and its provenance need. Holdings rows are kept complete. */
function reduceHolding(row: Record<string, unknown>) {
  return {
    name: row.name ?? null,
    ticker: row.ticker ?? null,
    section: row.section ?? null,
    assetType: row.assetType ?? null,
    owner: row.owner ?? null,
    value: row.value ?? null,
    valueRange: row.valueRange ?? null,
  };
}
function reduceTxnHolding(row: Record<string, unknown>) {
  return {
    ticker: row.ticker ?? null,
    name: row.name ?? null,
    sources: row.sources ?? null,
    tradeCount: row.tradeCount ?? null,
    sides: row.sides ?? null,
    firstDate: row.firstDate ?? null,
    lastDate: row.lastDate ?? null,
    note: row.note ?? null,
  };
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(join(outDir, "holdings"), { recursive: true });

const profileFiles = readdirSync(join(sourceDir, "profiles")).filter((f) => f.endsWith(".json")).sort();
const manifestPeople: Record<string, unknown>[] = [];

for (const file of profileFiles) {
  const profile = JSON.parse(readFileSync(join(sourceDir, "profiles", file), "utf8"));
  const slug = String(profile.slug);
  const fmp = profile.fmpLatest ?? {};
  const summary = summaryBySlug.get(slug) ?? {};
  const holdings = (fmp.holdings ?? []).map(reduceHolding);
  const txnHoldings = (fmp.holdingsFromTransactions ?? []).map(reduceTxnHolding);
  const tickerHoldings = holdings.filter((h: { ticker: unknown }) => h.ticker);

  const reduced = {
    slug,
    bioguideId: profile.bioguideId ?? null,
    name: profile.name ?? null,
    party: profile.party ?? null,
    state: profile.state ?? null,
    title: profile.title ?? null,
    fmpYear: fmp.year ?? null,
    yearsAvailable: fmp.yearsAvailable ?? null,
    bookSource: summary.bookSource ?? null,
    annualFetchComplete: fmp.annualFetchComplete ?? summary.annualFetchComplete ?? null,
    annualFetchIssues: fmp.annualFetchIssues ?? null,
    holdingsCount: holdings.length,
    holdingsWithTickerCount: tickerHoldings.length,
    holdingsFromTransactionsCount: txnHoldings.length,
    holdings,
    holdingsFromTransactions: txnHoldings,
  };
  writeFileSync(join(outDir, "holdings", `${slug}.json`), JSON.stringify(reduced, null, 1) + "\n");
  manifestPeople.push({
    slug,
    bioguideId: reduced.bioguideId,
    name: reduced.name,
    fmpYear: reduced.fmpYear,
    bookSource: reduced.bookSource,
    annualFetchComplete: reduced.annualFetchComplete,
    holdingsCount: reduced.holdingsCount,
    holdingsWithTickerCount: reduced.holdingsWithTickerCount,
    holdingsFromTransactionsCount: reduced.holdingsFromTransactionsCount,
    holdingsFileSha256: sha256(JSON.stringify(reduced)),
  });
}

writeFileSync(join(outDir, "completeness-summary.json"), JSON.stringify(completeness, null, 1) + "\n");
writeFileSync(join(outDir, "README.md"), readme.endsWith("\n") ? readme : readme + "\n");

const manifest = {
  bucket: "pelositracker-fmp-latest-top20",
  sourceZip: "pelositracker-fmp-latest-top20.zip",
  sourceSha256: sourceSha,
  extractedFrom: "profiles/*.json (FMP annual holdings kept complete; performance/trade tapes dropped)",
  note: "Holdings verbatim from the captain drop; this is the vault-leg mapping source of truth. Not net worth, not NAV.",
  peopleCount: manifestPeople.length,
  people: manifestPeople.sort((a, b) => String(a.slug).localeCompare(String(b.slug))),
};
writeFileSync(join(outDir, "MANIFEST.json"), JSON.stringify(manifest, null, 1) + "\n");

console.log(JSON.stringify({ out: outDir, people: manifestPeople.length, sourceSha256: sourceSha }, null, 1));
