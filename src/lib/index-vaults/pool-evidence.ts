/**
 * Pluggable per-mint Raydium pool evidence for person-index vault legs.
 *
 * Pool identity comes from observed mainnet USDC CLMM/CPMM evidence, never guessed addresses.
 * `raydium-pools-mainnet.ts` owns the snapshot. `PENDING_POOL_SOURCE` represents missing
 * evidence; `poolSourceFromReadiness` adapts the snapshot without changing its meaning.
 */

export type PoolEvidence = {
  mint: string;
  pool: string;
  /** Observed Raydium pool kind. */
  kind: string;
  programId: string;
  quoteMint: string;
  tvlUsd: number;
  observedAt: string;
};

/** Mirrors `raydium-pools-mainnet.ts` `PoolReadiness` exactly so adoption is a one-line swap. */
export type PoolReadinessResult = {
  status: "observed" | "thin" | "none";
  pool: PoolEvidence | null;
  reason: string | null;
};

export interface PoolEvidenceSource {
  /** When the underlying snapshot was observed; `null` for the pending placeholder. */
  fetchedAt: string | null;
  source: string;
  readiness(mint: string): PoolReadinessResult;
}

/** No concrete pool source wired yet: every mint is unobserved, never a guessed pool. */
export const PENDING_POOL_SOURCE: PoolEvidenceSource = Object.freeze({
  fetchedAt: null,
  source: "pending-raydium-pools-mainnet",
  readiness(): PoolReadinessResult {
    return { status: "none", pool: null, reason: "pool-evidence-pending" };
  },
});

/**
 * Adapt any `(mint) => { status; pool; reason }` reader (the landed `raydium-pools-mainnet`
 * `poolReadiness`) into a `PoolEvidenceSource`. The pool object is normalised to `PoolEvidence`
 * so callers never depend on the concrete snapshot type.
 */
export function poolSourceFromReadiness(
  reader: (mint: string) => { status: "observed" | "thin" | "none"; pool: unknown; reason: string | null },
  meta: { fetchedAt: string; source: string },
): PoolEvidenceSource {
  return {
    fetchedAt: meta.fetchedAt,
    source: meta.source,
    readiness(mint: string): PoolReadinessResult {
      const r = reader(mint);
      const p = r.pool as Record<string, unknown> | null;
      const pool: PoolEvidence | null = p
        ? {
            mint: String(p.mint ?? mint),
            pool: String(p.pool),
            kind: String(p.kind),
            programId: String(p.programId),
            quoteMint: String(p.quoteMint),
            tvlUsd: Number(p.tvlUsd),
            observedAt: String(p.observedAt),
          }
        : null;
      return { status: r.status, pool, reason: r.reason };
    },
  };
}

/** In-memory source for tests and fixtures. Only the mints handed in are observable. */
export function poolSourceFromEvidence(
  pools: readonly PoolEvidence[],
  meta: { fetchedAt: string; source: string } = { fetchedAt: "1970-01-01T00:00:00Z", source: "fixture" },
  minTvlUsd = 10_000,
): PoolEvidenceSource {
  const byMint = new Map(pools.map((p) => [p.mint, p]));
  return {
    fetchedAt: meta.fetchedAt,
    source: meta.source,
    readiness(mint: string): PoolReadinessResult {
      const pool = byMint.get(mint) ?? null;
      if (!pool) return { status: "none", pool: null, reason: "no-raydium-usdc-pool" };
      if (!(pool.tvlUsd >= minTvlUsd)) return { status: "thin", pool, reason: "raydium-pool-thin" };
      return { status: "observed", pool, reason: null };
    },
  };
}
