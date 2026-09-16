import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { snapshotCatalog } from "../src/lib/venues/solana-catalog.ts";
import { PENDING_POOL_SOURCE, poolSourceFromEvidence } from "../src/lib/index-vaults/pool-evidence.ts";
import { deriveAllPersonIndexes, toPersonBook } from "../src/lib/index-vaults/person-index-source.ts";
import { definitionForDb } from "../src/lib/index-vaults/vault-definition-store.ts";

const bucket = join(process.cwd(), "data/insiderindex-source-buckets/pelositracker-fmp-latest-top20");
const manifest = JSON.parse(readFileSync(join(bucket, "MANIFEST.json"), "utf8"));
const completeness = JSON.parse(readFileSync(join(bucket, "completeness-summary.json"), "utf8"));
const books = readdirSync(join(bucket, "holdings"))
  .filter((f) => f.endsWith(".json"))
  .sort()
  .map((f) => toPersonBook(JSON.parse(readFileSync(join(bucket, "holdings", f), "utf8"))));

test("committed bucket is the captain drop, versioned by source sha256, holdings not truncated", () => {
  assert.equal(manifest.sourceZip, "pelositracker-fmp-latest-top20.zip");
  assert.match(manifest.sourceSha256, /^[a-f0-9]{64}$/);
  assert.equal(manifest.people.length, 20);
  const summaryBySlug = new Map(completeness.summary.map((r: Record<string, unknown>) => [r.slug, r]));
  for (const person of manifest.people) {
    const s = summaryBySlug.get(person.slug) as Record<string, number | string>;
    assert.ok(s, `completeness has ${person.slug}`);
    // Every disclosed holding row is kept (no brief-style truncation).
    assert.equal(person.holdingsCount, s.holdings, `${person.slug} holdings kept whole`);
    assert.equal(person.bookSource, s.bookSource, `${person.slug} book source`);
  }
});

test("all 20 derive: txn-derived blocked, annual books mapped, unmapped disclosed", () => {
  assert.equal(books.length, 20);
  const defs = deriveAllPersonIndexes(books, snapshotCatalog(), PENDING_POOL_SOURCE);
  assert.equal(defs.length, 20);

  for (const def of defs) {
    // No definition silently loses weight: mapped + unmapped book weight is whole or zero.
    const cov = def.coverage;
    assert.equal(cov.mappableByWeightBps + cov.unmappedByWeightBps === 10_000 || cov.tickerCount === 0, true, def.slug);
    if (def.weightBasis === "annual-holding-value-midpoint") {
      const sum = def.legs.reduce((s, l) => s + l.targetWeightBps, 0);
      assert.equal(sum, 10_000, `${def.slug} legs sum`);
    } else {
      assert.equal(def.legs.length, 0, `${def.slug} non-annual has no legs`);
    }
  }

  // Transaction-derived books never carry weights.
  const txnDerived = defs.filter((d) => d.provenance.bookSource === "txn-derived");
  assert.ok(txnDerived.length >= 1);
  for (const d of txnDerived) {
    assert.equal(d.status, "BLOCKED");
    assert.deepEqual(d.blockedReasons, ["txn-derived-book"]);
    assert.equal(d.legs.length, 0);
  }

  // Pelosi (P000197) has an annual book with mapped legs and a disclosed unmapped share.
  const pelosi = defs.find((d) => d.bioguideId === "P000197")!;
  assert.equal(pelosi.weightBasis, "annual-holding-value-midpoint");
  assert.ok(pelosi.legs.length >= 2);
  assert.ok(pelosi.coverage.unmappedByWeightBps >= 0);
  assert.equal(pelosi.status, "WAIT_POOL_EVIDENCE"); // structure ready, pending pool evidence
});

test("the persisted record round-trips the full provenance, including annualFetchComplete false", () => {
  const defs = deriveAllPersonIndexes(books, snapshotCatalog(), PENDING_POOL_SOURCE);
  // Nancy Pelosi's annual fetch is incomplete in the captain data (far fewer ticker rows than
  // holdings): exactly the honesty the DB record must preserve without re-reading the source zip.
  const pelosi = defs.find((d) => d.slug === "nancy-pelosi")!;
  assert.equal(pelosi.provenance.annualFetchComplete, false);
  const row = definitionForDb(pelosi) as {
    bookSource: string | null;
    provenance: typeof pelosi.provenance;
  };
  // book_source stays its own queryable field AND the full provenance object is persisted.
  assert.equal(row.bookSource, pelosi.provenance.bookSource);
  assert.equal(row.provenance.annualFetchComplete, false);
  assert.equal(row.provenance.fmpYear, pelosi.provenance.fmpYear);
  assert.equal(row.provenance.holdingsCount, pelosi.provenance.holdingsCount);
  assert.equal(row.provenance.tickerHoldingsCount, pelosi.provenance.tickerHoldingsCount);
  assert.equal(row.provenance.weightedTickerCount, pelosi.provenance.weightedTickerCount);
  assert.equal(row.provenance.unweightedTickerCount, pelosi.provenance.unweightedTickerCount);
  assert.equal(typeof row.provenance.note, "string");
});

test("with observed pools the mapped legs become vault-ready", () => {
  // Feed observed pools for every mint the snapshot catalog resolved for one mapped person.
  const defsPending = deriveAllPersonIndexes(books, snapshotCatalog(), PENDING_POOL_SOURCE);
  const target = defsPending.find((d) => d.slug === "nancy-pelosi")!;
  const pools = poolSourceFromEvidence(
    target.legs.map((l) => ({ mint: l.mint, pool: `POOL_${l.mint}`, kind: "raydium_clmm", programId: "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK", quoteMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", tvlUsd: 500_000, observedAt: "2026-09-16T00:00:00Z" })),
  );
  const defs = deriveAllPersonIndexes(books, snapshotCatalog(), pools);
  const pelosi = defs.find((d) => d.slug === "nancy-pelosi")!;
  assert.equal(pelosi.coverage.vaultReadyLegCount, pelosi.legs.length);
  assert.equal(pelosi.status, "CREATABLE");
});
