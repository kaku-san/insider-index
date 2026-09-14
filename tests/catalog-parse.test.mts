import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  backpackUnderlying,
  catalogTickers,
  extractXStocksProducts,
  indexCatalog,
  normalizeTicker,
  parseBackpackAssets,
  parseXStocksProducts,
  preferredToken,
  xstockUnderlying,
  type CatalogToken,
} from "../src/lib/venues/catalog-parse.ts";

const NVDAX = "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh";
const NVDA_US = "NVDAe6Y7Tv5k8NqaEZmDHubX6pxnt6JWXnrK3XhYSGmM";

test("xstockUnderlying / backpackUnderlying / normalizeTicker", () => {
  assert.equal(xstockUnderlying("NVDAx"), "NVDA");
  assert.equal(xstockUnderlying("BRK.Bx"), "BRK.B");
  assert.equal(xstockUnderlying("NVDA"), null);
  assert.equal(xstockUnderlying("NVDAon"), null);
  assert.equal(backpackUnderlying("NVDA.US"), "NVDA");
  assert.equal(backpackUnderlying("BRK-B.US"), "BRK.B");
  assert.equal(backpackUnderlying("SOL"), null);
  assert.equal(normalizeTicker(" brk/b "), "BRK.B");
});

test("extractXStocksProducts reads __NEXT_DATA__ from HTML and bare _next/data JSON", () => {
  const products = [{ symbol: "NVDAx", name: "NVIDIA xStock", addresses: { solana: NVDAX, ethereum: "0x1" } }];
  const html = `<html><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { products } } })}</script></body></html>`;
  assert.deepEqual(extractXStocksProducts(html), products);
  assert.deepEqual(extractXStocksProducts(JSON.stringify({ pageProps: { products } })), products);
  assert.deepEqual(extractXStocksProducts("<html>redesigned</html>"), []);
  assert.deepEqual(extractXStocksProducts("not json"), []);
});

test("parseXStocksProducts keeps only products with a Solana mint", () => {
  const tokens = parseXStocksProducts([
    { symbol: "NVDAx", name: "NVIDIA xStock", addresses: { solana: NVDAX } },
    { symbol: "BRK.Bx", name: "Berkshire xStock", addresses: { solana: "XsBRKBmintmintmintmintmintmintmintmintmint1" } },
    { symbol: "EVMx", name: "EVM only", addresses: { solana: null, ethereum: "0xabc" } },
    { symbol: "BADx", name: "bad mint", addresses: { solana: "0xnotbase58" } },
    { symbol: "NVDA", name: "not an xstock symbol", addresses: { solana: NVDAX } },
  ]);
  assert.deepEqual(
    tokens.map((token) => [token.ticker, token.symbol, token.mint, token.decimals, token.issuer]),
    [
      ["NVDA", "NVDAx", NVDAX, 8, "xstock"],
      ["BRK.B", "BRK.Bx", "XsBRKBmintmintmintmintmintmintmintmintmint1", 8, "xstock"],
    ],
  );
});

test("parseBackpackAssets keeps .US assets with a Solana contract only", () => {
  const tokens = parseBackpackAssets([
    { symbol: "NVDA.US", displayName: "NVIDIA", tokens: [{ blockchain: "Solana", contractAddress: NVDA_US, nativeDecimals: 6 }] },
    { symbol: "VONV.US", displayName: "VONV.US", tokens: [{ blockchain: "Solana", contractAddress: null, nativeDecimals: null }] },
    { symbol: "SOL", displayName: "Solana", tokens: [{ blockchain: "Solana", contractAddress: "So11111111111111111111111111111111111111112", nativeDecimals: 9 }] },
    { symbol: "TEM.US", displayName: "Tempus", tokens: [{ blockchain: "Solana", contractAddress: "TEMmintmintmintmintmintmintmintmintmintmi1" }] },
  ]);
  assert.deepEqual(
    tokens.map((token) => [token.ticker, token.symbol, token.mint, token.decimals, token.issuer]),
    [
      ["NVDA", "NVDA.US", NVDA_US, 6, "backpack"],
      ["TEM", "TEM.US", "TEMmintmintmintmintmintmintmintmintmintmi1", 6, "backpack"],
    ],
  );
});

test("indexCatalog prefers the xStock mint, then Backpack, and dedupes mints", () => {
  const tokens: CatalogToken[] = [
    { issuer: "backpack", ticker: "NVDA", symbol: "NVDA.US", name: "NVIDIA", mint: NVDA_US, decimals: 6 },
    { issuer: "xstock", ticker: "NVDA", symbol: "NVDAx", name: "NVIDIA xStock", mint: NVDAX, decimals: 8 },
    { issuer: "xstock", ticker: "NVDA", symbol: "NVDAx", name: "dupe", mint: NVDAX, decimals: 8 },
    { issuer: "backpack", ticker: "TEM", symbol: "TEM.US", name: "Tempus", mint: "TEMmintmintmintmintmintmintmintmintmintmi1", decimals: 6 },
  ];
  const index = indexCatalog(tokens);
  assert.equal(index.size, 3);
  assert.equal(preferredToken(index, "nvda")?.symbol, "NVDAx");
  assert.equal(preferredToken(index, "TEM")?.symbol, "TEM.US");
  assert.equal(preferredToken(index, "IBTA"), null);
  assert.equal(index.byMint.get(NVDA_US)?.issuer, "backpack");
  assert.deepEqual(catalogTickers(tokens), ["NVDA", "TEM"]);
  assert.deepEqual(catalogTickers(tokens, "xstock"), ["NVDA"]);
});

test("the committed snapshot is well-formed and covers the Pelosi-Tracker names with a mint", () => {
  const snapshot = JSON.parse(readFileSync(new URL("../src/lib/venues/catalog-snapshot.json", import.meta.url), "utf8")) as {
    fetchedAt: string;
    xstocks: CatalogToken[];
    backpack: CatalogToken[];
  };
  assert.ok(Number.isFinite(Date.parse(snapshot.fetchedAt)));
  assert.ok(snapshot.xstocks.length > 500, `xstocks ${snapshot.xstocks.length}`);
  assert.ok(snapshot.backpack.length > 500, `backpack ${snapshot.backpack.length}`);
  const index = indexCatalog([...snapshot.xstocks, ...snapshot.backpack]);
  for (const ticker of ["NVDA", "AAPL", "GOOGL", "AMZN", "AVGO", "PANW", "CRWD", "TEM", "VST"]) {
    assert.ok(preferredToken(index, ticker), `${ticker} should have a Solana mint`);
  }
  assert.equal(preferredToken(index, "NVDA")?.issuer, "xstock");
  assert.equal(preferredToken(index, "TEM")?.issuer, "backpack");
  assert.equal(preferredToken(index, "IBTA"), null, "London-listed IBTA has no Solana mint");
});
