import type { CatalogIndex, CatalogToken } from "../venues/catalog-parse.ts";
import { preferredToken } from "../venues/catalog-parse.ts";
import { MIN_RAYDIUM_POOL_TVL_USD, poolReadiness, type MainnetRaydiumPool } from "../index-vaults/raydium-pools-mainnet.ts";
import { PINNED_PERSON_ID } from "../fmp/top-profiles.ts";
import type { TrackerProfile } from "./tracker-parse.ts";

/**
 * Vault-ready index from PelosiTracker *positions*: the investable slice of the shown current book.
 *
 * Membership: a tracker top holding that resolves to a Solana catalog mint (xStock first, Backpack
 * otherwise) AND has an observed mainnet Raydium USDC pool above the thin-pool floor. Everything
 * else is listed as excluded with its reason. Weights are the tracker's own position percentages
 * renormalized over the included names to exactly 10,000 bps — proportions only. The tracker's
 * dollar total is never a NAV, share counts are never used, and the recent-trade tape is never an
 * input.
 */
export const TRACKER_INDEX_BASIS = "pelositracker-positions" as const;
export const TRACKER_INDEX_METHODOLOGY = "tracker-position-percentages-renormalized" as const;
/** Product rule for every index: holders exit to USDC, never to a bag of xStocks. Exit stays disabled until a USDC-out quote exists and the 0 bps host exit fee is what the transaction does. */
export const EXIT_POLICY = "exit is USDC only (no in-kind xStock redemption); disabled until a USDC-out quote exists and the 0 bps host exit fee is what the transaction does" as const;
export type TrackerIndexExclusionReason = "no-solana-mint" | "no-raydium-usdc-pool" | "raydium-pool-thin" | "no-tracker-percentage";
export type TrackerIndexConstituent = {
  ticker: string; name: string | null; trackerPercentage: number; trackerValueUsd: number | null;
  token: CatalogToken; pool: MainnetRaydiumPool; weightBps: number;
};
export type TrackerIndexExcluded = { ticker: string; name: string | null; trackerPercentage: number | null; token: CatalogToken | null; pool: MainnetRaydiumPool | null; reason: TrackerIndexExclusionReason };
export type TrackerIndexReadiness = {
  status: "VAULT_CANDIDATE" | "WAIT_READINESS";
  firstLiveCandidate: boolean;
  reasons: string[];
  /** Composition readiness only; public funds stay behind `VAULT_RELEASE` and deployer evidence. */
  fundsEnabled: false;
};
export type TrackerIndexDefinition = {
  id: string;
  personId: string;
  indexName: string;
  basis: typeof TRACKER_INDEX_BASIS;
  methodology: typeof TRACKER_INDEX_METHODOLOGY;
  asOf: TrackerProfile["asOf"];
  sourceLabel: TrackerProfile["sourceLabel"];
  label: string;
  constituents: TrackerIndexConstituent[];
  excluded: TrackerIndexExcluded[];
  coverage: { includedTrackerPercentage: number; listedTrackerPercentage: number; holdingsListed: number; holdingsSlice: number };
  readiness: TrackerIndexReadiness;
  tradesUsed: false;
  navDisclaimer: string;
};

export function trackerIndexId(personId: string): string { return `tracker-${personId}`; }
export function trackerIndexName(baseIndexName: string): string { return `${baseIndexName} · Tracker positions`; }

/** Largest-remainder rounding to exactly 10,000 bps with a one-bp floor per name. */
export function renormalizeBps(scores: readonly number[]): number[] {
  if (!scores.length) return [];
  if (scores.some((s) => !Number.isFinite(s) || s <= 0)) throw new Error("positive-scores-required");
  if (scores.length > 10_000) throw new Error("too-many-holdings");
  const total = scores.reduce((a, b) => a + b, 0);
  const exact = scores.map((s) => (s / total) * 10_000);
  const bps = exact.map((s) => Math.max(1, Math.floor(s)));
  while (bps.reduce((a, b) => a + b, 0) > 10_000) bps[bps.indexOf(Math.max(...bps))]--;
  const order = exact.map((s, i) => ({ i, remainder: s - bps[i] })).sort((a, b) => b.remainder - a.remainder || a.i - b.i);
  const remaining = 10_000 - bps.reduce((a, b) => a + b, 0);
  for (let i = 0; i < remaining; i++) bps[order[i % order.length].i]++;
  return bps;
}

export function buildTrackerIndex(
  profile: TrackerProfile,
  baseIndexName: string,
  catalog: CatalogIndex,
  pools: readonly MainnetRaydiumPool[],
  minTvlUsd = MIN_RAYDIUM_POOL_TVL_USD,
): TrackerIndexDefinition {
  const included: Omit<TrackerIndexConstituent, "weightBps">[] = [];
  const excluded: TrackerIndexExcluded[] = [];
  for (const holding of profile.topHoldings) {
    const token = preferredToken(catalog, holding.ticker);
    const base = { ticker: holding.ticker, name: holding.name, trackerPercentage: holding.percentage };
    if (!token) { excluded.push({ ...base, token: null, pool: null, reason: "no-solana-mint" }); continue; }
    const readiness = poolReadiness(token.mint, pools, minTvlUsd);
    if (readiness.status !== "observed") { excluded.push({ ...base, token, pool: readiness.pool, reason: readiness.reason as TrackerIndexExclusionReason }); continue; }
    if (holding.percentage === null || !(holding.percentage > 0)) { excluded.push({ ...base, token, pool: readiness.pool, reason: "no-tracker-percentage" }); continue; }
    included.push({ ticker: holding.ticker, name: holding.name, trackerPercentage: holding.percentage, trackerValueUsd: holding.valueUsd, token, pool: readiness.pool! });
  }
  // Duplicate mints (two tickers resolving to one token) are merged so the vault never lists a mint twice.
  const byMint = new Map<string, Omit<TrackerIndexConstituent, "weightBps">>();
  for (const row of included) {
    const existing = byMint.get(row.token.mint);
    if (existing) byMint.set(row.token.mint, { ...existing, trackerPercentage: existing.trackerPercentage + row.trackerPercentage, trackerValueUsd: existing.trackerValueUsd !== null && row.trackerValueUsd !== null ? existing.trackerValueUsd + row.trackerValueUsd : null });
    else byMint.set(row.token.mint, row);
  }
  const merged = [...byMint.values()].sort((a, b) => b.trackerPercentage - a.trackerPercentage || a.ticker.localeCompare(b.ticker));
  const bps = renormalizeBps(merged.map((row) => row.trackerPercentage));
  const constituents = merged.map((row, i) => ({ ...row, weightBps: bps[i] }));
  const includedPct = constituents.reduce((sum, row) => sum + row.trackerPercentage, 0);
  const listedPct = profile.topHoldings.reduce((sum, row) => sum + (row.percentage ?? 0), 0);
  const reasons: string[] = [];
  if (constituents.length === 0) reasons.push("no tracker position has both a catalog mint and an observed Raydium USDC pool");
  else if (constituents.length < 2) reasons.push("fewer than two investable names");
  if (excluded.length) reasons.push(`${excluded.length} of ${profile.topHoldings.length} listed positions excluded (${[...new Set(excluded.map((row) => row.reason))].join(", ")})`);
  const firstLiveCandidate = profile.id === PINNED_PERSON_ID;
  const status: TrackerIndexReadiness["status"] = constituents.length >= 2 ? "VAULT_CANDIDATE" : "WAIT_READINESS";
  if (status === "VAULT_CANDIDATE") reasons.push("composition only: deployer readiness evidence, route checks and release gates still apply");
  reasons.push(EXIT_POLICY);
  return {
    id: trackerIndexId(profile.id), personId: profile.id, indexName: trackerIndexName(baseIndexName),
    basis: TRACKER_INDEX_BASIS, methodology: TRACKER_INDEX_METHODOLOGY, asOf: profile.asOf, sourceLabel: profile.sourceLabel,
    label: `PelosiTracker top ${profile.topHoldings.length} positions as of ${profile.asOf}: names with a Solana catalog mint and an observed Raydium USDC pool, weighted by the tracker's position percentages renormalized to 10,000 bps.`,
    constituents, excluded,
    coverage: { includedTrackerPercentage: Math.round(includedPct * 100) / 100, listedTrackerPercentage: Math.round(listedPct * 100) / 100, holdingsListed: profile.topHoldings.length, holdingsSlice: profile.coverage.holdingsSlice },
    readiness: { status, firstLiveCandidate, reasons, fundsEnabled: false },
    tradesUsed: false,
    navDisclaimer: "PelosiTracker's dollar total is a third-party estimate of the member's book, not this index's NAV. Weights are proportions of the investable slice only.",
  };
}
