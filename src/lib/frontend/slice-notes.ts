/**
 * Presentation of a NAV vault's tradable slice next to the disclosed book. Pure: no `@/` aliases, env or
 * fetch. The slice itself comes from the NAV readiness response (published `insiderindex_nav_vault_slices`,
 * falling back to the committed `src/lib/nav-vault/tradable-slices.json`); nothing here is per index.
 */
import type { AllocationInput } from "./allocation-view.ts";

export type SliceExcluded = { ticker: string; reason: string; mint?: string | null; disclosedWeightBps?: number | null };
export type SliceHeld = { ticker: string; mint?: string | null; disclosedWeightBps?: number | null; targetWeightBps?: number | null };
export type NavSlice = {
  tradableLegs: number;
  totalLegs: number | null;
  disclosedWeightBps: number | null;
  excluded: SliceExcluded[];
  vaultLegs?: SliceHeld[];
};
/** Held rows carry the vault target weight; excluded rows carry the plain reason and disclosed weight. */
export type SliceMark =
  | { held: true; targetWeightBps: number | null }
  | { held: false; reason: string; disclosedWeightBps: number | null };

export const SLICE_FOOTNOTE = "*Not held in the vault yet. Added as soon as trading volume and liquidity improve.";

/** "Tradable slice: 5 of 18 holdings (72.6% of disclosed weight)"; null when totals are unknown. */
export function sliceHeadline(slice?: NavSlice | null): string | null {
  if (!slice || slice.totalLegs == null || slice.disclosedWeightBps == null) return null;
  return `Tradable slice: ${slice.tradableLegs} of ${slice.totalLegs} holdings (${(slice.disclosedWeightBps / 100).toFixed(1)}% of disclosed weight)`;
}

/** Scan reason ("no Jupiter or Raydium route", "price moves X% between a $10 and a $100 buy") → plain English. */
export function plainSliceReason(reason: string): string {
  const text = reason.trim().toLowerCase();
  if (text.startsWith("price moves")) return "Market too thin right now";
  if (text.startsWith("no jupiter") || text.startsWith("no route") || text.includes("route")) return "No tradable liquidity on Solana yet";
  if (text === "not scanned") return "Liquidity not checked yet";
  return "Not tradable on Solana yet";
}

export function formatBps(bps: number): string {
  return `${(bps / 100).toFixed(bps >= 1000 ? 1 : 2)}%`;
}

const tickerKey = (ticker: string) => ticker.trim().toUpperCase();
function finder<T extends { ticker: string; mint?: string | null }>(list: T[]) {
  const byMint = new Map(list.filter(item => item.mint).map(item => [item.mint as string, item]));
  const byTicker = new Map(list.map(item => [tickerKey(item.ticker), item]));
  return (item: { ticker: string; mint?: string | null }) => (item.mint ? byMint.get(item.mint) : undefined) ?? byTicker.get(tickerKey(item.ticker));
}

/**
 * Mark each allocation row as held (vault target) or excluded (asterisk + reason). Every excluded name stays
 * listed: one missing from the source rows is appended (unweighted, so the chart is never re-drawn from it).
 * Without a slice headline (no NAV vault, or totals unknown), the rows are returned untouched.
 */
export function withSliceMarks(items: AllocationInput[], slice?: NavSlice | null): AllocationInput[] {
  if (!sliceHeadline(slice)) return items;
  const excluded = finder(slice!.excluded);
  const held = finder(slice!.vaultLegs ?? []);
  const used = new Set<SliceExcluded>();
  const marked = items.map(item => {
    const out = excluded(item);
    if (out) {
      used.add(out);
      return { ...item, sliceMark: { held: false, reason: plainSliceReason(out.reason), disclosedWeightBps: out.disclosedWeightBps ?? null } satisfies SliceMark };
    }
    const leg = held(item);
    return leg ? { ...item, sliceMark: { held: true, targetWeightBps: leg.targetWeightBps ?? null } satisfies SliceMark } : item;
  });
  const missing = slice!.excluded.filter(item => !used.has(item)).map(item => ({
    ticker: item.ticker,
    weightBps: Number.NaN,
    mint: item.mint ?? null,
    sliceMark: { held: false, reason: plainSliceReason(item.reason), disclosedWeightBps: item.disclosedWeightBps ?? null } satisfies SliceMark,
  }));
  return [...marked, ...missing];
}
