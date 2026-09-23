/** Presentation only: never changes the definition used to invest or rebalance. */
export type AllocationInput = { ticker: string; name?: string | null; weightBps: number; mint?: string | null; issuer?: string | null; tokenSymbol?: string | null; network?: string | null };
export type AllocationRow = AllocationInput & { key: string; otherCount?: number; missing?: boolean };
export const ALLOCATION_COLORS = ["#ed6943", "#6862cb", "#27836e", "#ce9b35", "#497cac", "#bc648a", "#736957", "#999891"];
export function allocationView(items: AllocationInput[], limit = 7) {
  // Key by the caller's item position so the legend can match chart slices to the full list.
  const valid = items.map((x, i) => ({ ...x, key: `${x.ticker}-${i}` }))
    .filter(x => Number.isFinite(x.weightBps) && x.weightBps > 0)
    .sort((a, b) => b.weightBps - a.weightBps || a.ticker.localeCompare(b.ticker));
  const totalBps = valid.reduce((sum, x) => sum + x.weightBps, 0);
  const take = valid.length <= limit ? valid.length : Math.max(1, limit - 1);
  const rows: AllocationRow[] = valid.slice(0, take);
  if (take < valid.length) rows.push({ key: "other", ticker: "OTHER", name: "Other holdings", otherCount: valid.length - take, weightBps: valid.slice(take).reduce((sum, x) => sum + x.weightBps, 0) });
  // A source may only expose a slice. Do not invent constituents to fill the circle.
  if (totalBps > 0 && totalBps < 9999) rows.push({ key: "unreported", ticker: "UNREPORTED", name: "Unreported allocation", weightBps: 10000 - totalBps, missing: true });
  return { rows, count: valid.length, totalBps, denominator: Math.max(10000, totalBps), topThreeBps: valid.slice(0, 3).reduce((sum, x) => sum + x.weightBps, 0) };
}
