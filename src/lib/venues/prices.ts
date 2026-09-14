/**
 * Last on-chain price per Solana mint via Jupiter Price API v3 (keyless).
 * Used to size basket legs and to value an insider's reported share count when
 * the print itself carried no price. A mint without a Jupiter pool simply has
 * no price — the holding still shows, sized "unknown" rather than invented.
 */

import { memo } from "@/lib/cache";

export const JUPITER_PRICE_URL = "https://lite-api.jup.ag/price/v3";
const BATCH = 50;
const TTL_MS = 5 * 60_000;

type PricePayload = Record<string, { usdPrice?: number } | null | undefined>;

async function fetchBatch(mints: readonly string[]): Promise<Record<string, number>> {
  const response = await fetch(`${JUPITER_PRICE_URL}?ids=${mints.join(",")}`, {
    headers: { Accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Jupiter price ${response.status}`);
  const payload = (await response.json()) as PricePayload;
  const out: Record<string, number> = {};
  for (const mint of mints) {
    const price = payload[mint]?.usdPrice;
    if (typeof price === "number" && Number.isFinite(price) && price > 0) out[mint] = price;
  }
  return out;
}

/** USD price per mint; mints Jupiter cannot price are simply absent. Never throws. */
export async function fetchMintPrices(mints: readonly string[]): Promise<Record<string, number>> {
  const unique = [...new Set(mints.filter(Boolean))].sort();
  const batches: string[][] = [];
  for (let i = 0; i < unique.length; i += BATCH) batches.push(unique.slice(i, i + BATCH));
  const results = await Promise.all(
    batches.map((batch) =>
      memo(`jup:price:${batch.join(",")}`, { ttlMs: TTL_MS }, () => fetchBatch(batch)).catch(
        () => ({}) as Record<string, number>,
      ),
    ),
  );
  return Object.assign({}, ...results);
}
