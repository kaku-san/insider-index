/**
 * Pure parsers for the two Solana tokenised-equity catalogs we route to.
 * No fetch, no env, no path aliases — unit-tested directly with `node --test`.
 *
 *  xStocks (Backed Finance)  https://xstocks.com/us/products
 *    Next.js page; `__NEXT_DATA__.props.pageProps.products[]` carries
 *    { symbol: "NVDAx", name, addresses: { solana: <mint> } }.
 *
 *  Backpack tokenised stocks  https://api.backpack.exchange/api/v1/assets
 *    Every `<TICKER>.US` asset with a Solana `contractAddress` is an on-chain
 *    token we can swap. Brokerage-only symbols (no mint) are NOT a buy list.
 *
 * Out of the catalog on purpose: Ondo Global Markets (mint list needs a key we
 * do not hold — never invent mints), Superstate Opening Bell (KYC-allowlisted
 * wallets, not anonymous Jupiter), PreStocks (pre-IPO SPVs, not public names).
 */

export type CatalogIssuer = "xstock" | "backpack";

export type CatalogToken = {
  issuer: CatalogIssuer;
  /** Underlying US ticker as it appears on filings: NVDA, BRK.B. */
  ticker: string;
  /** Token symbol on the venue: NVDAx, NVDA.US. */
  symbol: string;
  name: string;
  mint: string;
  decimals: number;
};

/** Filing tickers arrive as BRK.B / BRK-B / BRK/B; the catalog uses one form. */
export function normalizeTicker(raw: string): string {
  return raw.trim().toUpperCase().replace(/[-/]/g, ".");
}

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function isSolanaMint(value: unknown): value is string {
  return typeof value === "string" && BASE58.test(value);
}

// ── xStocks ────────────────────────────────────────────────────────────────

export type XStocksProduct = {
  slug?: string;
  name?: string;
  symbol?: string;
  addresses?: { solana?: string | null } & Record<string, string | null | undefined>;
};

/** xStocks tokens are Token-2022 with 8 decimals. */
export const XSTOCK_DECIMALS = 8;

/** "NVDAx" → "NVDA", "BRK.Bx" → "BRK.B". Null when it is not an xStock symbol. */
export function xstockUnderlying(symbol: string): string | null {
  const match = /^([A-Z][A-Z0-9.]*)x$/.exec(symbol.trim());
  return match ? normalizeTicker(match[1]) : null;
}

/** Extract the products array from the raw xstocks.com HTML or `_next/data` JSON. */
export function extractXStocksProducts(payload: string): XStocksProduct[] {
  const text = payload.trim();
  let json = text;
  if (text.startsWith("<")) {
    const match = /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/.exec(text);
    if (!match) return [];
    json = match[1];
  }
  try {
    const data = JSON.parse(json) as {
      props?: { pageProps?: { products?: XStocksProduct[] } };
      pageProps?: { products?: XStocksProduct[] };
    };
    const products = data.props?.pageProps?.products ?? data.pageProps?.products;
    return Array.isArray(products) ? products : [];
  } catch {
    return [];
  }
}

export function parseXStocksProducts(products: readonly XStocksProduct[] | null | undefined): CatalogToken[] {
  if (!Array.isArray(products)) return [];
  const out: CatalogToken[] = [];
  for (const product of products) {
    const symbol = product?.symbol?.trim();
    const mint = product?.addresses?.solana;
    if (!symbol || !isSolanaMint(mint)) continue;
    const ticker = xstockUnderlying(symbol);
    if (!ticker) continue;
    out.push({
      issuer: "xstock",
      ticker,
      symbol,
      name: product.name?.trim() || symbol,
      mint,
      decimals: XSTOCK_DECIMALS,
    });
  }
  return out;
}

// ── Backpack ───────────────────────────────────────────────────────────────

export type BackpackAssetRow = {
  symbol?: string;
  displayName?: string;
  tokens?: {
    blockchain?: string;
    contractAddress?: string | null;
    nativeDecimals?: number | null;
  }[];
};

export const BACKPACK_DEFAULT_DECIMALS = 6;

/** "NVDA.US" → "NVDA". Null for anything that is not a US-listed token. */
export function backpackUnderlying(symbol: string): string | null {
  const match = /^([A-Z][A-Z0-9.-]*?)\.US$/i.exec(symbol.trim());
  return match ? normalizeTicker(match[1]) : null;
}

/** Only `.US` assets that actually have a Solana mint. One row per ticker. */
export function parseBackpackAssets(rows: readonly BackpackAssetRow[] | null | undefined): CatalogToken[] {
  if (!Array.isArray(rows)) return [];
  const out: CatalogToken[] = [];
  for (const row of rows) {
    const symbol = row?.symbol?.trim();
    if (!symbol) continue;
    const ticker = backpackUnderlying(symbol);
    if (!ticker) continue;
    const token = row.tokens?.find(
      (entry: NonNullable<BackpackAssetRow["tokens"]>[number]) =>
        entry?.blockchain?.toLowerCase() === "solana" && isSolanaMint(entry.contractAddress),
    );
    if (!token) continue;
    out.push({
      issuer: "backpack",
      ticker,
      symbol: symbol.toUpperCase(),
      name: row.displayName?.trim() || symbol,
      mint: token.contractAddress as string,
      decimals:
        typeof token.nativeDecimals === "number" && Number.isInteger(token.nativeDecimals) && token.nativeDecimals >= 0
          ? token.nativeDecimals
          : BACKPACK_DEFAULT_DECIMALS,
    });
  }
  return out;
}

// ── Catalog index ──────────────────────────────────────────────────────────

export const ISSUER_PREFERENCE: readonly CatalogIssuer[] = ["xstock", "backpack"];

export type CatalogIndex = {
  /** Per ticker, in issuer preference order (xStock mint first, then Backpack). */
  byTicker: Map<string, CatalogToken[]>;
  byMint: Map<string, CatalogToken>;
  size: number;
};

export function indexCatalog(tokens: readonly CatalogToken[]): CatalogIndex {
  const byTicker = new Map<string, CatalogToken[]>();
  const byMint = new Map<string, CatalogToken>();
  for (const token of tokens) {
    if (byMint.has(token.mint)) continue;
    byMint.set(token.mint, token);
    const bucket = byTicker.get(token.ticker) ?? [];
    // One token per issuer per ticker; first seen wins.
    if (bucket.some((entry) => entry.issuer === token.issuer)) continue;
    bucket.push(token);
    bucket.sort((a, b) => ISSUER_PREFERENCE.indexOf(a.issuer) - ISSUER_PREFERENCE.indexOf(b.issuer));
    byTicker.set(token.ticker, bucket);
  }
  return { byTicker, byMint, size: byMint.size };
}

/** Preferred token for a filing ticker: xStock, then Backpack, else null. */
export function preferredToken(index: CatalogIndex, ticker: string): CatalogToken | null {
  return index.byTicker.get(normalizeTicker(ticker))?.[0] ?? null;
}

/** Distinct underlying tickers, sorted. Useful as a disclosure query universe. */
export function catalogTickers(tokens: readonly CatalogToken[], issuer?: CatalogIssuer): string[] {
  return [...new Set(tokens.filter((token) => !issuer || token.issuer === issuer).map((token) => token.ticker))].sort();
}
