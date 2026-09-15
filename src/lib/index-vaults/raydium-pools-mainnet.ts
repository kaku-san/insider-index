import snapshot from "./raydium-pools-mainnet.json" with { type: "json" };
import type { RaydiumOracleKind } from "./raydium-oracles.ts";

/**
 * Documented mainnet `mint → Raydium USDC pool` observations for tokenised-stock mints.
 *
 * Symmetry prices are Raydium-only, so a name can only join a vault composition when a Raydium
 * CLMM/CPMM pool quoted in mainnet USDC has actually been observed for its mint. The snapshot is
 * written by `npm run raydium:snapshot` from Raydium's public pool API and is evidence of what was
 * observed on `fetchedAt`, not a live quote and not the devnet settlement bindings
 * (`DEVNET_RAYDIUM_POOLS`). Never edit it by hand; re-run the snapshot before any deployer step.
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
  kind: RaydiumOracleKind;
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
