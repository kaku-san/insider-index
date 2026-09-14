import type { IndexConstituent, PersonIndex, Venue } from "@/lib/disclosures/types";

/**
 * One leg of a basket: a user-signed Jupiter swap from USDC into the leg's
 * Solana mint (xStock or Backpack token). `tokens` is an estimate from the
 * last price; the wallet shows the real fill.
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

type GlobalIndexes = typeof globalThis & {
  __stocklanaIndexPositions?: IndexPosition[];
};

function memoryStore(): IndexPosition[] {
  const globalRef = globalThis as GlobalIndexes;
  if (!globalRef.__stocklanaIndexPositions) {
    globalRef.__stocklanaIndexPositions = [];
  }
  return globalRef.__stocklanaIndexPositions;
}

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

export function listIndexPositions(wallet?: string): IndexPosition[] {
  const rows = memoryStore();
  return wallet ? rows.filter((row) => row.wallet === wallet) : [...rows];
}

export function recordIndexPosition(
  input: Omit<IndexPosition, "id" | "lastRebalancedAt" | "needsRebalance">,
): IndexPosition {
  const row: IndexPosition = {
    ...input,
    id: crypto.randomUUID(),
    lastRebalancedAt: new Date().toISOString(),
    needsRebalance: false,
  };
  memoryStore().unshift(row);
  return row;
}

export function markRebalanceFlags(indexes: PersonIndex[]): IndexPosition[] {
  const rows = memoryStore();
  for (const row of rows) {
    const live = indexes.find((index) => index.id === row.indexId);
    if (live && live.lastDisclosureId && live.lastDisclosureId !== row.lastDisclosureId) {
      row.needsRebalance = true;
    }
  }
  return rows;
}

export function applyRebalance(
  wallet: string,
  indexId: string,
  next: Pick<IndexPosition, "allocations" | "lastDisclosureId" | "signature" | "usdcIn">,
): IndexPosition | null {
  const row = memoryStore().find((item) => item.wallet === wallet && item.indexId === indexId);
  if (!row) return null;
  row.allocations = next.allocations;
  row.lastDisclosureId = next.lastDisclosureId;
  row.signature = next.signature;
  row.usdcIn = next.usdcIn;
  row.lastRebalancedAt = new Date().toISOString();
  row.needsRebalance = false;
  return row;
}

export function constituentLabel(row: IndexConstituent): string {
  return `${row.venueSymbol} ${(row.weightPct * 100).toFixed(0)}%`;
}
