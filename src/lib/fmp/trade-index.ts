import { createHash } from "node:crypto";
import { normalizeTicker, preferredToken, type CatalogIndex, type CatalogToken } from "../venues/catalog-parse.ts";
import type { Activity } from "./types.ts";

export type TradeConstituent = {
  ticker: string; mint: string; issuer: CatalogToken["issuer"]; weightBps: number;
  token: CatalogToken; tradeIds: string[]; evidencedMidpoint: number | null;
};
export type TradeIndexDefinition = {
  methodology: "trade-band-midpoints" | "equal-weight-mapped-names";
  basis: "disclosed-trade-activity";
  label: string;
  personId: string;
  period: string;
  sourceHash: string;
  constituents: TradeConstituent[];
  excluded: { tradeId: string; ticker: string | null; name: string | null; reason: string }[];
  evidence: Activity[];
};
export function contentHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** A model of observed activity, NOT a reconstruction of remaining holdings.
 * Annual data is deliberately not an input. Sales contribute gross activity too.
 */
export function buildTradeIndex(personId: string, trades: readonly Activity[], catalog: CatalogIndex): TradeIndexDefinition | null {
  const evidence = [...trades].sort((a, b) => a.id.localeCompare(b.id));
  const excluded: TradeIndexDefinition["excluded"] = [];
  const mapped = new Map<string, { token: CatalogToken; trades: Activity[] }>();
  for (const trade of evidence) {
    const ticker = trade.ticker ? normalizeTicker(trade.ticker) : null;
    const token = ticker ? preferredToken(catalog, ticker) : null;
    const reason = trade.personId !== personId ? "person-mismatch"
      : !["stock", "etf"].includes(trade.kind) ? "ineligible-instrument"
      : !ticker ? "no-source-symbol"
      : !trade.transactionDate || !/^\d{4}-\d{2}-\d{2}$/.test(trade.transactionDate) ? "missing-transaction-date"
      : !token ? "no-solana-mint" : null;
    if (reason) { excluded.push({ tradeId: trade.id, ticker, name: trade.name, reason }); continue; }
    const group = mapped.get(token!.mint) ?? { token: token!, trades: [] };
    group.trades.push(trade);
    mapped.set(token!.mint, group);
  }
  if (!mapped.size) return null;
  const groups = [...mapped.values()].sort((a, b) => a.token.ticker.localeCompare(b.token.ticker));
  const sizes = groups.map(({ trades }) => {
    let sum = 0;
    for (const { amount: { low, high } } of trades) {
      if (low === null || high === null || !Number.isFinite(low) || !Number.isFinite(high) || low < 0 || high < low || high === 0) return null;
      sum += low / 2 + high / 2;
    }
    return Number.isFinite(sum) && sum > 0 ? sum : null;
  });
  const weighted = sizes.every((size) => size !== null);
  const scores = sizes.map((size) => weighted ? size! : 1);
  const total = scores.reduce((a, b) => a + b, 0);
  const exact = scores.map((score) => score / total * 10_000);
  const bps = exact.map((n) => Math.max(1, Math.floor(n)));
  if (bps.length > 10_000) throw new Error("Too many mapped names for basis-point weights");
  // Keep every mapped name representable at one basis point, taking dust from the largest leg.
  while (bps.reduce((a, b) => a + b, 0) > 10_000) {
    const largest = bps.indexOf(Math.max(...bps));
    bps[largest]--;
  }
  const remainderOrder = exact.map((n, i) => ({ i, remainder: n - bps[i] })).sort((a, b) => b.remainder - a.remainder || a.i - b.i);
  const remaining = 10_000 - bps.reduce((a, b) => a + b, 0);
  for (let n = 0; n < remaining; n++) bps[remainderOrder[n].i]++;
  return {
    methodology: weighted ? "trade-band-midpoints" : "equal-weight-mapped-names",
    basis: "disclosed-trade-activity",
    label: weighted
      ? "Target weights proportional to summed disclosed trade-band midpoints (buys and sales); not current holdings."
      : "Equal-weight mapped names: at least one mapped trade lacks a usable closed size band; not current holdings.",
    personId,
    period: groups.flatMap((g) => g.trades.map((t) => t.transactionDate!)).sort().at(-1)!,
    sourceHash: contentHash(evidence), evidence, excluded,
    constituents: groups.map(({ token, trades }, i) => ({ ticker: token.ticker, mint: token.mint, issuer: token.issuer, token, weightBps: bps[i], tradeIds: trades.map((t) => t.id), evidencedMidpoint: sizes[i] })),
  };
}

export type PublishedTradeIndex = {
  hash: string; person_id: string; period: string; version: number; status: string;
  published_at: string; definition: TradeIndexDefinition;
  constituents: { ticker: string; mint: string; issuer: string; weight_bps: number; payload: TradeConstituent }[];
};
