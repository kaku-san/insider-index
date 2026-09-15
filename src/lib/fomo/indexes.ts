import type { IndexConstituent, PersonIndex, Venue } from "@/lib/disclosures/types";

/**
 * Legacy display-only allocation DTO. Not a swap plan or native ownership.
 * Native index execution lives in index-vaults/adapter-contract.ts.
 */
export type IndexAllocation = {
  ticker: string;
  venue: Exclude<Venue, "none">;
  venueSymbol: string;
  mint: string;
  mintDecimals: number;
  weightPct: number;
  usdc: number;
  /** Estimated token quantity; null when no live price was available. */
  tokens: number | null;
};

export type IndexPosition = {
  id: string;
  wallet: string;
  indexId: string;
  indexName: string;
  usdcIn: number;
  allocations: IndexAllocation[];
  lastDisclosureId: string | null;
  lastRebalancedAt: string;
  needsRebalance: boolean;
  signature: string;
};

export function allocateIndex(index: PersonIndex, usdcAmount: number): IndexAllocation[] {
  return index.constituents.map((row) => ({
    ticker: row.ticker,
    venue: row.venue,
    venueSymbol: row.venueSymbol,
    mint: row.mint,
    mintDecimals: row.mintDecimals,
    weightPct: row.weightPct,
    usdc: Number((usdcAmount * row.weightPct).toFixed(2)),
    tokens: null,
  }));
}

export function withTokenEstimates(
  allocations: IndexAllocation[],
  prices: Record<string, number>,
): IndexAllocation[] {
  return allocations.map((row) => ({
    ...row,
    tokens: prices[row.mint] ? Number((row.usdc / prices[row.mint]).toFixed(4)) : null,
  }));
}

export function constituentLabel(row: IndexConstituent): string {
  return `${row.venueSymbol} ${(row.weightPct * 100).toFixed(0)}%`;
}
