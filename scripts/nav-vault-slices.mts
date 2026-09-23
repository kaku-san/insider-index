/**
 * Tradable slices for NAV vaults (captain decision B, 2026-09-23). The disclosed book is never
 * rewritten: this derives, per index, the legs that actually route (Jupiter v1 on CPI-safe DEXes,
 * Raydium fallback) at $0.05, $10 and $100 with a sane price (the $100 fill's price within 2% of the
 * $10 fill's), renormalizes their disclosed weights, caps at 25 legs (largest weights) and records every
 * excluded name with its reason.
 *
 *   node --experimental-strip-types scripts/nav-vault-slices.mts [--source URL] [--liquidity cached.json] [--out FILE]
 *
 * Needs JUPITER_API_KEY unless --liquidity is given. Output: src/lib/nav-vault/tradable-slices.json.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { JUPITER_CPI_SAFE_DEXES } from "../src/lib/nav-vault/keeper.ts";

const args = process.argv.slice(2);
const opt = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const SOURCE = opt("--source") ?? "https://insiderindex.xyz/api/vault-indexes";
const OUT = opt("--out") ?? "src/lib/nav-vault/tradable-slices.json";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const MAX_DRIFT_PCT = 2;
export const MIN_SLICE_LEGS = 3;
export const MIN_SLICE_WEIGHT_BPS = 3000;
const MAX_LEGS = 25;

type Leg = { ticker: string; mint: string; decimals: number; provider?: string; targetWeightBps: number; pool?: { pool?: string } | null };
type Definition = { indexId: string; kind: string; name: string; weightBasis?: string; legs?: Leg[] };
type Liquidity = { small: boolean; p10: number | null; p100: number | null; driftPct: number | null; via?: string | null };

async function quote(mint: string, amount: number, key: string) {
  const url = new URL("https://api.jup.ag/swap/v1/quote");
  url.searchParams.set("inputMint", USDC); url.searchParams.set("outputMint", mint); url.searchParams.set("amount", String(amount));
  url.searchParams.set("slippageBps", "50"); url.searchParams.set("dexes", JUPITER_CPI_SAFE_DEXES.join(","));
  for (let attempt = 0; attempt < 4; attempt++) {
    const response = await fetch(url, { headers: { "x-api-key": key } });
    if (response.status === 429) { await new Promise(r => setTimeout(r, 2000)); continue; }
    if (!response.ok) return null;
    const body = await response.json() as { outAmount?: string; routePlan?: { swapInfo: { label: string } }[] };
    return body.outAmount ? { out: BigInt(body.outAmount), via: (body.routePlan ?? []).map(r => r.swapInfo.label).join(">") } : null;
  }
  return null;
}

async function scan(legs: Leg[]): Promise<Record<string, Liquidity>> {
  const key = process.env.JUPITER_API_KEY?.trim();
  if (!key) throw new Error("JUPITER_API_KEY is required (or pass --liquidity).");
  const out: Record<string, Liquidity> = {};
  for (const leg of legs) {
    if (out[leg.mint]) continue;
    const [small, mid, big] = [await quote(leg.mint, 50_000, key), await quote(leg.mint, 10_000_000, key), await quote(leg.mint, 100_000_000, key)];
    const px = (q: { out: bigint } | null, usd: number) => q && q.out > 0n ? usd / (Number(q.out) / 10 ** leg.decimals) : null;
    const p10 = px(mid, 10), p100 = px(big, 100);
    out[leg.mint] = { small: Boolean(small), p10, p100, driftPct: p10 && p100 ? (p100 / p10 - 1) * 100 : null, via: mid?.via ?? big?.via ?? null };
    await new Promise(r => setTimeout(r, 150));
  }
  return out;
}

export function tradable(l: Liquidity | undefined): boolean {
  return Boolean(l && l.small && l.p10 && l.p100 && l.driftPct !== null && Math.abs(l.driftPct) <= MAX_DRIFT_PCT);
}
export function exclusionReason(l: Liquidity | undefined): string {
  if (!l) return "not scanned";
  if (!l.p10 && !l.p100) return "no Jupiter or Raydium route";
  if (!l.p10 || !l.p100) return "no route at $10 or $100";
  if (!l.small) return "no route at $0.05";
  return `price moves ${Math.abs(l.driftPct ?? 0).toFixed(1)}% between a $10 and a $100 buy`;
}

/** Largest-remainder renormalization of the kept disclosed weights to 10,000 bps. */
export function renormalize(weights: number[]): number[] {
  const total = weights.reduce((a, b) => a + b, 0);
  const raw = weights.map(w => (w * 10_000) / total);
  const out = raw.map(Math.floor);
  const rest = 10_000 - out.reduce((a, b) => a + b, 0);
  raw.map((x, i) => [x - Math.floor(x), i] as const).sort((a, b) => b[0] - a[0]).slice(0, rest).forEach(([, i]) => { out[i]! += 1; });
  return out;
}

export function slice(definition: Definition, liquidity: Record<string, Liquidity>) {
  const legs = definition.legs ?? [];
  const kept = legs.filter(leg => tradable(liquidity[leg.mint])).sort((a, b) => b.targetWeightBps - a.targetWeightBps).slice(0, MAX_LEGS);
  const disclosedWeightBps = kept.reduce((s, l) => s + l.targetWeightBps, 0);
  const weights = kept.length ? renormalize(kept.map(l => l.targetWeightBps)) : [];
  return {
    indexId: definition.indexId, kind: definition.kind, name: definition.name,
    totalLegs: legs.length, tradableLegs: kept.length, disclosedWeightBps,
    eligible: kept.length >= MIN_SLICE_LEGS && disclosedWeightBps >= MIN_SLICE_WEIGHT_BPS,
    vaultLegs: kept.map((l, i) => ({ ticker: l.ticker, mint: l.mint, decimals: l.decimals, provider: l.provider ?? null, pool: l.pool?.pool ?? null, disclosedWeightBps: l.targetWeightBps, targetWeightBps: weights[i]! })),
    excluded: legs.filter(l => !kept.includes(l)).map(l => ({ ticker: l.ticker, mint: l.mint, disclosedWeightBps: l.targetWeightBps, reason: tradable(liquidity[l.mint]) ? "beyond the 25-leg cap" : exclusionReason(liquidity[l.mint]) })),
  };
}

async function main() {
  const body = await (await fetch(SOURCE)).json() as { indexes: Definition[] };
  const definitions = body.indexes.filter(d => d.weightBasis === "annual-holding-value-midpoint" || d.weightBasis === "thematic-multi-member-value");
  const cached = opt("--liquidity");
  const liquidity: Record<string, Liquidity> = cached ? JSON.parse(readFileSync(cached, "utf8")) : await scan(definitions.flatMap(d => d.legs ?? []));
  const slices = definitions.map(d => slice(d, liquidity));
  writeFileSync(OUT, `${JSON.stringify({
    generatedAt: new Date().toISOString(), source: SOURCE,
    criteria: { dexes: JUPITER_CPI_SAFE_DEXES, sizesUsdc: [0.05, 10, 100], maxDriftPct: MAX_DRIFT_PCT, minLegs: MIN_SLICE_LEGS, minDisclosedWeightBps: MIN_SLICE_WEIGHT_BPS, maxLegs: MAX_LEGS },
    slices,
  }, null, 2)}\n`);
  for (const s of slices) console.log(s.indexId.padEnd(40), `${s.tradableLegs}/${s.totalLegs}`.padStart(6), `${(s.disclosedWeightBps / 100).toFixed(1)}%`.padStart(7), s.eligible ? "eligible" : "research only");
}

if (import.meta.url === `file://${process.argv[1]}`) void main();
