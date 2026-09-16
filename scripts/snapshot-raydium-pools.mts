/**
 * Refresh `src/lib/index-vaults/raydium-pools-mainnet.json` from Raydium's public pool API.
 *
 *   npm run raydium:snapshot                 # tracker top-holding mints (+ FMP constituents when Supabase env is set)
 *   npm run raydium:snapshot -- --mints=<mint>,<mint>
 *
 * Policy: mainnet USDC quote only, Raydium CLMM/CPMM programs only (the oracle kinds Symmetry
 * supports), highest TVL wins. Mints with no such pool are recorded as unresolved. Nothing is
 * invented and nothing here touches devnet settlement bindings.
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { normalizeTrackerHandoff } from "../src/lib/tracker/tracker-parse.ts";
import { indexCatalog, preferredToken, type CatalogToken } from "../src/lib/venues/catalog-parse.ts";
import { PENDING_POOL_SOURCE } from "../src/lib/index-vaults/pool-evidence.ts";
import { deriveAllPersonIndexes, toPersonBook } from "../src/lib/index-vaults/person-index-source.ts";
import { MAINNET_USDC_MINT, RAYDIUM_CLMM_PROGRAM, RAYDIUM_CPMM_PROGRAM, type MainnetRaydiumPool, type MainnetRaydiumPoolSnapshot } from "../src/lib/index-vaults/raydium-pools-mainnet.ts";

const RAYDIUM_API = "https://api-v3.raydium.io/pools/info/mint";
const HANDOFF = new URL("../data/insiderindex-source-buckets/pelositracker-top20rere-handoff/top20-agent-brief.json", import.meta.url);
// The vault-leg source of truth: the FMP annual-holdings bucket the definitions map from. Its
// resolved leg mints must all be probed, or a leg could sit unresolved only because it was never
// asked about (distinct from having no pool).
const FMP_BUCKET = new URL("../data/insiderindex-source-buckets/pelositracker-fmp-latest-top20/holdings", import.meta.url);
const CATALOG = new URL("../src/lib/venues/catalog-snapshot.json", import.meta.url);
const OUT = new URL("../src/lib/index-vaults/raydium-pools-mainnet.json", import.meta.url);

type RaydiumPoolRow = { id: string; type: string; programId: string; tvl: number; day?: { volume?: number }; mintA: { address: string }; mintB: { address: string } };

async function candidateMints(): Promise<Map<string, string | null>> {
  const catalog = JSON.parse(readFileSync(CATALOG, "utf8")) as { xstocks: CatalogToken[]; backpack: CatalogToken[] };
  const index = indexCatalog([...catalog.xstocks, ...catalog.backpack]);
  const mints = new Map<string, string | null>();
  const handoff = normalizeTrackerHandoff(JSON.parse(readFileSync(HANDOFF, "utf8")));
  for (const profile of handoff.profiles) for (const holding of profile.topHoldings) {
    const token = preferredToken(index, holding.ticker);
    if (token) mints.set(token.mint, token.symbol);
  }
  // Every mapped leg the vault definitions consume, resolved through the same mapping code so the
  // snapshot's candidate set is exactly the set of mints those definitions can ask about.
  const bucketDir = fileURLToPath(FMP_BUCKET);
  const books = readdirSync(bucketDir).filter((f) => f.endsWith(".json")).sort()
    .map((f) => toPersonBook(JSON.parse(readFileSync(join(bucketDir, f), "utf8"))));
  let legMintCount = 0;
  for (const def of deriveAllPersonIndexes(books, index, PENDING_POOL_SOURCE)) {
    for (const leg of def.legs) { if (!mints.has(leg.mint)) legMintCount++; mints.set(leg.mint, `${leg.ticker} (${leg.provider})`); }
  }
  console.log(`FMP annual bucket: ${legMintCount} additional mapped-leg mints`);
  for (const arg of process.argv.slice(2)) {
    const match = /^--mints=(.+)$/.exec(arg);
    if (match) for (const mint of match[1].split(",")) if (mint.trim()) mints.set(mint.trim(), null);
  }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (url && key) {
    const { createClient } = await import("@supabase/supabase-js");
    const db = createClient(url, key, { auth: { persistSession: false } });
    const ids = handoff.profiles.map((profile) => profile.id);
    const { data: versions } = await db.from("index_versions").select("hash").in("person_id", ids).eq("status", "CANDIDATE").eq("definition->>basis", "disclosed-holdings");
    const { data: constituents } = await db.from("constituents").select("mint,ticker,issuer").in("index_hash", (versions ?? []).map((row: { hash: string }) => row.hash));
    for (const row of (constituents ?? []) as { mint: string; ticker: string; issuer: string }[]) if (!mints.has(row.mint)) mints.set(row.mint, `${row.ticker} (${row.issuer})`);
    console.log(`Supabase: ${constituents?.length ?? 0} published FMP constituents for the handoff people`);
  } else console.log("Supabase env not set: FMP published constituents not included");
  return mints;
}

async function fetchPools(mint: string): Promise<RaydiumPoolRow[]> {
  const params = new URLSearchParams({ mint1: mint, mint2: MAINNET_USDC_MINT, poolType: "all", poolSortField: "liquidity", sortType: "desc", pageSize: "50", page: "1" });
  const response = await fetch(`${RAYDIUM_API}?${params}`, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const json = await response.json() as { success?: boolean; data?: { data?: RaydiumPoolRow[] } };
  if (!json.success) throw new Error("Raydium API returned success=false");
  return json.data?.data ?? [];
}

const mints = await candidateMints();
console.log(`${mints.size} candidate mints`);
const observedAt = new Date().toISOString();
const pools: MainnetRaydiumPool[] = [];
const unresolved: MainnetRaydiumPoolSnapshot["unresolved"] = [];
for (const [mint, symbol] of [...mints.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
  try {
    const rows = (await fetchPools(mint))
      .filter((row) => [RAYDIUM_CLMM_PROGRAM, RAYDIUM_CPMM_PROGRAM].includes(row.programId))
      .filter((row) => [row.mintA.address, row.mintB.address].includes(MAINNET_USDC_MINT) && [row.mintA.address, row.mintB.address].includes(mint))
      .filter((row) => Number.isFinite(row.tvl) && row.tvl > 0)
      .sort((a, b) => b.tvl - a.tvl);
    const best = rows[0];
    if (!best) { unresolved.push({ mint, symbol, reason: "no-raydium-usdc-clmm-cpmm-pool" }); console.log(`${symbol ?? mint}: none`); continue; }
    pools.push({
      mint, symbol, pool: best.id, kind: best.programId === RAYDIUM_CLMM_PROGRAM ? "raydium_clmm" : "raydium_cpmm", programId: best.programId,
      quoteMint: MAINNET_USDC_MINT, tvlUsd: Math.round(best.tvl * 100) / 100, dayVolumeUsd: Number.isFinite(best.day?.volume) ? Math.round(best.day!.volume! * 100) / 100 : null, observedAt,
    });
    console.log(`${symbol ?? mint}: ${best.type} ${best.id} tvl=$${Math.round(best.tvl).toLocaleString("en-US")}`);
  } catch (error) {
    unresolved.push({ mint, symbol, reason: `fetch-failed: ${error instanceof Error ? error.message : String(error)}` });
    console.log(`${symbol ?? mint}: fetch failed`);
  }
  await new Promise((resolve) => setTimeout(resolve, 200));
}
const out: MainnetRaydiumPoolSnapshot = { fetchedAt: observedAt, source: RAYDIUM_API, quoteMint: MAINNET_USDC_MINT, pools, unresolved };
writeFileSync(OUT, `${JSON.stringify(out, null, 2)}\n`);
console.log(`Wrote ${pools.length} pools, ${unresolved.length} unresolved → ${OUT.pathname}`);
