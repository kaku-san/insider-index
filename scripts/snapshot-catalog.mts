/**
 * Refresh the offline Solana catalog snapshot used when the live xStocks /
 * Backpack catalogs are unreachable (cold start, build, CI).
 *
 *   npm run catalog:snapshot
 *
 * Keyless. Writes src/lib/venues/catalog-snapshot.json. Never edit that file
 * by hand — a mint we did not read from an issuer is a mint we do not trust.
 */

import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  extractXStocksProducts,
  parseBackpackAssets,
  parseXStocksProducts,
  type BackpackAssetRow,
} from "../src/lib/venues/catalog-parse.ts";

const XSTOCKS_URL = "https://xstocks.com/us/products";
const BACKPACK_URL = "https://api.backpack.exchange/api/v1/assets";

async function text(url: string): Promise<string> {
  const response = await fetch(url, { headers: { Accept: "text/html,application/json" }, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`${url} → HTTP ${response.status}`);
  return response.text();
}

const [xstocksHtml, backpackJson] = await Promise.all([text(XSTOCKS_URL), text(BACKPACK_URL)]);
const xstocks = parseXStocksProducts(extractXStocksProducts(xstocksHtml));
const backpack = parseBackpackAssets(JSON.parse(backpackJson) as BackpackAssetRow[]);

if (xstocks.length < 100) throw new Error(`xStocks catalog looks truncated (${xstocks.length} tokens); not overwriting snapshot`);
if (backpack.length < 100) throw new Error(`Backpack catalog looks truncated (${backpack.length} tokens); not overwriting snapshot`);

const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/lib/venues/catalog-snapshot.json");
const sortByTicker = (a: { ticker: string }, b: { ticker: string }) => a.ticker.localeCompare(b.ticker);
const line = (rows: unknown[]) => rows.map((row) => `  ${JSON.stringify(row)}`).join(",\n");
await writeFile(
  out,
  `{\n "fetchedAt": ${JSON.stringify(new Date().toISOString())},\n "xstocks": [\n${line(xstocks.sort(sortByTicker))}\n ],\n "backpack": [\n${line(backpack.sort(sortByTicker))}\n ]\n}\n`,
);
console.log(`snapshot: ${xstocks.length} xStocks + ${backpack.length} Backpack Solana mints → ${path.relative(process.cwd(), out)}`);
