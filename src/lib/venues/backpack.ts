/**
 * Backpack Exchange venue discovery — live, keyless, memoised.
 * When the market list is unreachable we serve the last good snapshot, or an
 * empty map on a cold start: a name is never marked tradable by guesswork.
 */

import { memo } from "@/lib/cache";
import {
  indexBackpackListings,
  parseBackpackMarkets,
  type BackpackListing,
  type BackpackMarketRow,
} from "@/lib/venues/backpack-parse";

export const BACKPACK_MARKETS_URL = "https://api.backpack.exchange/api/v1/markets";
const TTL_MS = 60 * 60_000;

export function backpackDisabled(): boolean {
  return process.env.BACKPACK_DISABLED?.trim() === "1";
}

export async function fetchBackpackListings(): Promise<Map<string, BackpackListing>> {
  if (backpackDisabled()) return new Map();
  try {
    return await memo("backpack:markets", { ttlMs: TTL_MS }, async () => {
      const response = await fetch(BACKPACK_MARKETS_URL, {
        headers: { Accept: "application/json" },
        cache: "no-store",
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`Backpack ${response.status}`);
      const rows = (await response.json()) as BackpackMarketRow[];
      return indexBackpackListings(parseBackpackMarkets(rows));
    });
  } catch {
    return new Map();
  }
}

export function warmBackpackListings(): void {
  void fetchBackpackListings();
}
