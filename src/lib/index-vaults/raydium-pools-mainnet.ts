import snapshot from "./raydium-pools-mainnet.json" with { type: "json" };
export type RaydiumPoolKind = "raydium_clmm" | "raydium_cpmm";

/**
 * Documented mainnet `mint → Raydium USDC pool` observations for tokenised-stock mints.
 *
 * CLMM/CPMM pools quoted in mainnet USDC are recorded only when observed for that mint.
 * `npm run raydium:snapshot` generates this evidence from Raydium's public API. It describes
 * `fetchedAt`, not a live quote or NAV readiness. Never edit the snapshot by hand.
 */
export const MAINNET_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const RAYDIUM_CLMM_PROGRAM = "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK";
export const RAYDIUM_CPMM_PROGRAM = "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C";
/**
 * A pool this thin is a manipulable oracle, not a price source. Names below the floor stay on the
 * shown book and in the index's excluded list; they never receive vault weight.
 */
export const MIN_RAYDIUM_POOL_TVL_USD = 10_000;

export type MainnetRaydiumPool = {
  mint: string;
  symbol: string | null;
  pool: string;
  kind: RaydiumPoolKind;
  programId: string;
  quoteMint: typeof MAINNET_USDC_MINT;
  tvlUsd: number;
  dayVolumeUsd: number | null;
  observedAt: string;
};
export type MainnetRaydiumPoolSnapshot = {
  fetchedAt: string;
  source: string;
  quoteMint: string;
  pools: MainnetRaydiumPool[];
  unresolved: { mint: string; symbol: string | null; reason: string }[];
};

const SNAPSHOT = snapshot as MainnetRaydiumPoolSnapshot;

export function mainnetRaydiumPoolSnapshot(): MainnetRaydiumPoolSnapshot { return SNAPSHOT; }

/** Observed pool for a mint, or null. Null means "not listable", never a guessed pool. */
export function mainnetRaydiumPoolFor(mint: string, pools: readonly MainnetRaydiumPool[] = SNAPSHOT.pools): MainnetRaydiumPool | null {
  return pools.find((entry) => entry.mint === mint) ?? null;
}

export type PoolReadiness = { status: "observed" | "thin" | "none"; pool: MainnetRaydiumPool | null; reason: string | null };
export function poolReadiness(mint: string, pools: readonly MainnetRaydiumPool[] = SNAPSHOT.pools, minTvlUsd = MIN_RAYDIUM_POOL_TVL_USD): PoolReadiness {
  const pool = mainnetRaydiumPoolFor(mint, pools);
  if (!pool) return { status: "none", pool: null, reason: "no-raydium-usdc-pool" };
  if (!(pool.tvlUsd >= minTvlUsd)) return { status: "thin", pool, reason: "raydium-pool-thin" };
  return { status: "observed", pool, reason: null };
}

/**
 * A pool snapshot is evidence observed at `fetchedAt`, not a live quote. Before a deployer step
 * consumes it the age must be judged: an old snapshot may miss pools that have since drained or
 * appeared, so it must never be presented as if freshly observed. The threshold is deliberately
 * tight — re-run `npm run raydium:snapshot` before any creatable decision.
 */
export const POOL_SNAPSHOT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export type SnapshotFreshness = { fetchedAt: string; observedAtMs: number; now: string; ageMs: number; maxAgeMs: number; stale: boolean };

/** Pure, injected-clock freshness judgement. An unparseable `fetchedAt` is treated as infinitely stale. */
export function snapshotFreshness(fetchedAt: string, now: Date = new Date(), maxAgeMs = POOL_SNAPSHOT_MAX_AGE_MS): SnapshotFreshness {
  const observedAtMs = Date.parse(fetchedAt);
  const nowMs = now.getTime();
  const ageMs = Number.isFinite(observedAtMs) ? nowMs - observedAtMs : Number.POSITIVE_INFINITY;
  return { fetchedAt, observedAtMs, now: now.toISOString(), ageMs, maxAgeMs, stale: !(ageMs >= 0 && ageMs <= maxAgeMs) };
}

/** Fail closed on a stale (or unparseable, or future-dated) snapshot rather than use it as if fresh. */
export function assertFreshPoolSnapshot(fetchedAt: string, now: Date = new Date(), maxAgeMs = POOL_SNAPSHOT_MAX_AGE_MS): SnapshotFreshness {
  const freshness = snapshotFreshness(fetchedAt, now, maxAgeMs);
  if (freshness.stale) {
    const ageHours = Number.isFinite(freshness.ageMs) ? (freshness.ageMs / 3_600_000).toFixed(1) : "\u221e";
    throw new Error(
      `STALE_POOL_SNAPSHOT: raydium-pools-mainnet observed ${fetchedAt} is ${ageHours}h old (max ${(maxAgeMs / 3_600_000).toFixed(1)}h); re-run \`npm run raydium:snapshot\` before deriving creatable vaults`,
    );
  }
  return freshness;
}
