import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { candidateMints } from "../scripts/snapshot-raydium-pools.mts";
import { snapshotCatalog } from "../src/lib/venues/solana-catalog.ts";
import { PENDING_POOL_SOURCE, poolSourceFromReadiness } from "../src/lib/index-vaults/pool-evidence.ts";
import { mainnetRaydiumPoolSnapshot, poolReadiness } from "../src/lib/index-vaults/raydium-pools-mainnet.ts";
import { deriveAllThematicIndexes } from "../src/lib/index-vaults/thematic-index-map.ts";
import { deriveAllPersonIndexes, toPersonBook } from "../src/lib/index-vaults/person-index-source.ts";

// ORCL on silicon-hill: a thematic-only constituent that lives in no person book. Before the
// snapshot probed thematic constituents it was never asked about, so its real ~$20k Raydium USDC
// CLMM pool was invisible and the leg looked untradable. Its mint is the invariant under test.
const ORCL_MINT = "XsjFwUPiLofddX5cWFHW35GCbXcSu1BCUGfxoQAQjeL";

const BUCKET = fileURLToPath(new URL("../data/insiderindex-source-buckets/pelositracker-fmp-latest-top20/holdings", import.meta.url));
function personBooks() {
  return readdirSync(BUCKET)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => toPersonBook(JSON.parse(readFileSync(join(BUCKET, f), "utf8"))));
}

test("a thematic-only mint is present in the snapshot candidate set", async () => {
  const catalog = snapshotCatalog();

  // ORCL is a real leg of a thematic basket…
  const thematicLegMints = new Set(deriveAllThematicIndexes(catalog, PENDING_POOL_SOURCE).flatMap((d) => d.legs.map((l) => l.mint)));
  assert.ok(thematicLegMints.has(ORCL_MINT), "ORCL must be a thematic constituent leg mint");

  // …that no person book carries, so before the fix the snapshot never asked about it.
  const personLegMints = new Set(deriveAllPersonIndexes(personBooks(), catalog, PENDING_POOL_SOURCE).flatMap((d) => d.legs.map((l) => l.mint)));
  assert.ok(!personLegMints.has(ORCL_MINT), "ORCL is thematic-only: absent from every person book, so it would be missed without probing thematic constituents");

  // The snapshot candidate set now includes it, because it probes thematic constituents too.
  const mints = await candidateMints();
  assert.ok(mints.has(ORCL_MINT), "the snapshot candidate set must include the thematic-only mint");
});

test("every definition leg was probed — a leg with a real pool is never left unrecorded", () => {
  const catalog = snapshotCatalog();
  const snapshot = mainnetRaydiumPoolSnapshot();
  const poolSource = poolSourceFromReadiness((mint) => poolReadiness(mint, snapshot.pools), { fetchedAt: snapshot.fetchedAt, source: snapshot.source });

  // Every mint the committed snapshot actually asked about: observed (has a pool) or unresolved
  // (probed, no pool). A leg mint in neither set was never probed — exactly the defect under test.
  const probed = new Set<string>([...snapshot.pools.map((p) => p.mint), ...snapshot.unresolved.map((u) => u.mint)]);

  const definitions = [
    ...deriveAllPersonIndexes(personBooks(), catalog, poolSource),
    ...deriveAllThematicIndexes(catalog, poolSource),
  ];
  const unprobed: string[] = [];
  for (const def of definitions) {
    for (const leg of def.legs) if (!probed.has(leg.mint)) unprobed.push(`${def.slug}:${leg.ticker}(${leg.mint})`);
  }
  assert.deepEqual(unprobed, [], `these legs were never probed by the snapshot: ${unprobed.join(", ")}`);

  // ORCL specifically: recorded with an observed, tradable pool — not unresolved, not absent.
  const orcl = snapshot.pools.find((p) => p.mint === ORCL_MINT);
  assert.ok(orcl, "ORCL must be recorded as an observed pool");
  assert.ok(orcl!.tvlUsd >= 10_000, "ORCL's recorded pool must clear the $10k TVL floor");
  assert.equal(poolReadiness(ORCL_MINT, snapshot.pools).status, "observed");
});
