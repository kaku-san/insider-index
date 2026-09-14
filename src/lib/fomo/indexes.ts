import type { IndexConstituent, PersonIndex, Venue, VenueMarket } from "@/lib/disclosures/types";

/**
 * One leg of a basket. `execution: "swap"` legs are xStocks bought in-app via
 * a user-signed Jupiter order; `"external"` legs are names only available on
 * another venue (Backpack) and are surfaced as links, never executed for you.
 */
export type IndexAllocation = {
  ticker: string;
  xstockSymbol: string | null;
  mint: string | null;
  venue: Exclude<Venue, "none">;
  venueSymbol: string;
  venueMarket: VenueMarket;
  venueHref: string | null;
  execution: "swap" | "external";
  weightPct: number;
  usdc: number;
  tokens: number;
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
    xstockSymbol: row.xstockSymbol,
    mint: row.mint,
    venue: row.venue,
    venueSymbol: row.venueSymbol,
    venueMarket: row.venueMarket,
    venueHref: row.venueHref,
    execution: row.venue === "xstock" && row.mint ? "swap" : "external",
    weightPct: row.weightPct,
    usdc: Number((usdcAmount * row.weightPct).toFixed(2)),
    tokens: 0,
  }));
}

export function withTokenEstimates(
  allocations: IndexAllocation[],
  prices: Record<string, number>,
): IndexAllocation[] {
  return allocations.map((row) => ({
    ...row,
    tokens: row.mint && prices[row.mint] ? Number((row.usdc / prices[row.mint]).toFixed(4)) : 0,
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
