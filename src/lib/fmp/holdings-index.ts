import type { Snapshot } from "./types.ts";
import type { HoldingResolution } from "./holding-resolution.ts";
import { contentHash } from "./trade-index.ts";

export type SavedSnapshot = { id: string; payload: Snapshot };
/** Latest observed annual document, not the latest trade date or an older complete year. */
export function latestHoldingSnapshot(personId: string, snapshots: readonly SavedSnapshot[]) {
  return snapshots.filter((s) => s.payload.personId === personId && s.payload.referenceDate && s.payload.items.length)
    .sort((a, b) => b.payload.referenceDate!.localeCompare(a.payload.referenceDate!) ||
      (b.payload.filingDate ?? "").localeCompare(a.payload.filingDate ?? "") || a.id.localeCompare(b.id))[0] ?? null;
}
export type HoldingsConstituent = {
  ticker: string; mint: string; issuer: "xstock" | "backpack"; weightBps: number;
  token: NonNullable<HoldingResolution["token"]>; holdingIds: string[]; evidencedMidpoint: number | null;
};
export type HoldingsIndexDefinition = {
  basis: "disclosed-holdings"; methodology: "holding-band-midpoints" | "equal-weight-mapped-holdings";
  label: string; personId: string; period: string; snapshotId: string; snapshotComplete: boolean;
  snapshotIssues: string[]; sourceHash: string; evidence: HoldingResolution[];
  constituents: HoldingsConstituent[];
  excluded: { holdingId: string; ticker: string | null; name: string | null; reason: string }[];
};
export function buildHoldingsIndex(snapshot: SavedSnapshot, resolutions: readonly HoldingResolution[]): HoldingsIndexDefinition | null {
  const { payload: book } = snapshot;
  if (!book.referenceDate || book.items.some((i) => i.personId !== book.personId)) return null;
  const evidence = [...resolutions].sort((a, b) => a.holding.id.localeCompare(b.holding.id));
  if (evidence.length !== book.items.length || new Set(evidence.map((r) => r.holding.id)).size !== book.items.length ||
    book.items.some((item) => !evidence.some((r) => r.holding.id === item.id && contentHash(r.holding) === contentHash(item)))) throw new Error("holding-evidence-mismatch");
  const groups = new Map<string, { token: NonNullable<HoldingResolution["token"]>; rows: HoldingResolution[] }>();
  const excluded: HoldingsIndexDefinition["excluded"] = [];
  for (const r of evidence) {
    if (!r.token || r.reason || !["stock", "etf"].includes(r.holding.kind)) {
      excluded.push({ holdingId: r.holding.id, ticker: r.ticker, name: r.holding.name, reason: r.reason ?? "ineligible-instrument" }); continue;
    }
    const group = groups.get(r.token.mint) ?? { token: r.token, rows: [] };
    group.rows.push(r); groups.set(r.token.mint, group);
  }
  const mapped = [...groups.values()].sort((a, b) => a.token.ticker.localeCompare(b.token.ticker));
  if (!mapped.length) return null;
  const sizes = mapped.map(({ rows }) => {
    let sum = 0;
    for (const { holding: { valueRange: { low, high } } } of rows) {
      if (low === null || high === null || !Number.isFinite(low) || !Number.isFinite(high) || low < 0 || high < low || high === 0) return null;
      sum += low / 2 + high / 2;
    }
    return Number.isFinite(sum) && sum > 0 ? sum : null;
  });
  const weighted = sizes.every((s) => s !== null);
  const scores = sizes.map((s) => weighted ? s! : 1);
  const total = scores.reduce((a, b) => a + b, 0);
  const exact = scores.map((s) => s / total * 10000);
  const bps = exact.map((s) => Math.max(1, Math.floor(s)));
  if (bps.length > 10000) throw new Error("too-many-holdings");
  while (bps.reduce((a, b) => a + b, 0) > 10000) bps[bps.indexOf(Math.max(...bps))]--;
  const order = exact.map((s, i) => ({ i, remainder: s - bps[i] })).sort((a, b) => b.remainder - a.remainder || a.i - b.i);
  const remaining = 10000 - bps.reduce((a, b) => a + b, 0);
  for (let i = 0; i < remaining; i++) bps[order[i].i]++;
  return {
    basis: "disclosed-holdings", methodology: weighted ? "holding-band-midpoints" : "equal-weight-mapped-holdings",
    label: weighted ? "Latest saved annual holdings: mapped equity/ETF value-band midpoints, normalized over mapped holdings only."
      : "Latest saved annual holdings: equal weights over mapped names because at least one holding lacks a usable closed value band.",
    personId: book.personId, period: book.referenceDate, snapshotId: snapshot.id,
    snapshotComplete: book.complete, snapshotIssues: book.issues, sourceHash: snapshot.id, evidence, excluded,
    constituents: mapped.map(({ token, rows }, i) => ({ ticker: token.ticker, mint: token.mint, issuer: token.issuer, token,
      weightBps: bps[i], holdingIds: rows.map((r) => r.holding.id), evidencedMidpoint: sizes[i] })),
  };
}
export type PublishedHoldingsIndex = {
  hash: string; person_id: string; indexName?: string; period: string; version: number; status: string;
  published_at: string; definition: HoldingsIndexDefinition;
  constituents: { ticker: string; mint: string; issuer: string; weight_bps: number; payload: HoldingsConstituent }[];
};
