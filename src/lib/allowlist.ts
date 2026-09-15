/**
 * Buy gate for InsiderIndex.
 *
 * A swap is permitted only when the output mint is in the live Solana catalog
 * (`src/lib/venues/solana-catalog.ts`): an xStock mint read from xstocks.com or
 * a Backpack `.US` token read from api.backpack.exchange, with the committed
 * snapshot as the offline fallback. There is no hand-maintained mint list any
 * more — a mint we did not read from an issuer is a mint we do not buy.
 */

import type { CatalogToken } from "@/lib/venues/catalog-parse";
import { loadSolanaCatalog, snapshotCatalog } from "@/lib/venues/solana-catalog";

export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" as const;
export const USDC_DECIMALS = 6;

export type BuyableToken = CatalogToken;

/** Resolve a mint against the live catalog (falls back to the snapshot). */
export async function resolveBuyableMint(mint: string): Promise<BuyableToken | null> {
  const catalog = await loadSolanaCatalog();
  return catalog.byMint.get(mint.trim()) ?? null;
}

/** Synchronous check against whatever catalog is already in memory (snapshot on a cold start). */
export function peekBuyableMint(mint: string): BuyableToken | null {
  return snapshotCatalog().byMint.get(mint.trim()) ?? null;
}

export function toAtomicAmount(uiAmount: number, decimals: number): string {
  const factor = 10 ** decimals;
  return Math.round(uiAmount * factor).toString();
}

export function fromAtomicAmount(atomic: string | number, decimals: number): number {
  return Number(atomic) / 10 ** decimals;
}
