import test from "node:test";
import assert from "node:assert/strict";
import {
  assertFreshPoolSnapshot,
  mainnetRaydiumPoolSnapshot,
  POOL_SNAPSHOT_MAX_AGE_MS,
  snapshotFreshness,
} from "../src/lib/index-vaults/raydium-pools-mainnet.ts";

// Injected, fixed clock so the guard is deterministic and offline (no wall-clock dependence).
const NOW = new Date("2026-09-16T00:00:00Z");

test("a fresh snapshot is usable; a stale one is flagged and never silently used as fresh", () => {
  const fresh = new Date(NOW.getTime() - 60 * 60 * 1000).toISOString(); // 1h old
  const f = snapshotFreshness(fresh, NOW);
  assert.equal(f.stale, false);
  assert.ok(f.ageMs > 0 && f.ageMs < POOL_SNAPSHOT_MAX_AGE_MS);
  assert.doesNotThrow(() => assertFreshPoolSnapshot(fresh, NOW));

  const stale = new Date(NOW.getTime() - (POOL_SNAPSHOT_MAX_AGE_MS + 60_000)).toISOString();
  const s = snapshotFreshness(stale, NOW);
  assert.equal(s.stale, true);
  assert.ok(s.ageMs > POOL_SNAPSHOT_MAX_AGE_MS);
  assert.throws(() => assertFreshPoolSnapshot(stale, NOW), /STALE_POOL_SNAPSHOT/);
});

test("an unparseable or future-dated fetchedAt is treated as stale, not fresh", () => {
  assert.equal(snapshotFreshness("not-a-date", NOW).stale, true);
  assert.throws(() => assertFreshPoolSnapshot("not-a-date", NOW), /STALE_POOL_SNAPSHOT/);
  // A future observation instant (clock skew / tampering) is not "fresh": negative age is stale.
  const future = new Date(NOW.getTime() + 60 * 60 * 1000).toISOString();
  assert.equal(snapshotFreshness(future, NOW).stale, true);
  assert.throws(() => assertFreshPoolSnapshot(future, NOW), /STALE_POOL_SNAPSHOT/);
});

test("the committed snapshot carries a fetchedAt the freshness guard can judge", () => {
  const snap = mainnetRaydiumPoolSnapshot();
  assert.match(snap.fetchedAt, /^\d{4}-\d{2}-\d{2}T/);
  // Judged at its own observation instant it is fresh; against a far-future clock it is stale.
  assert.equal(snapshotFreshness(snap.fetchedAt, new Date(snap.fetchedAt)).stale, false);
  const farFuture = new Date(Date.parse(snap.fetchedAt) + POOL_SNAPSHOT_MAX_AGE_MS * 10);
  assert.equal(snapshotFreshness(snap.fetchedAt, farFuture).stale, true);
});
