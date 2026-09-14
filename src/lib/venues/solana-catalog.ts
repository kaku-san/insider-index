/**
 * Live Solana buy catalog: every tokenised US equity we can route a Jupiter
 * swap to, keyed by filing ticker. Two issuers, fetched keylessly and memoised:
 *
 *  1. xStocks   — xstocks.com product page (`__NEXT_DATA__`), ~700 Solana mints
 *  2. Backpack  — api.backpack.exchange/api/v1/assets, `.US` tokens with a mint
 *
 * When an issuer is unreachable we serve the committed snapshot
 * (`catalog-snapshot.json`, refreshed with `npm run catalog:snapshot`) so a
 * cold start or a build never marks the whole book untradable — and we never
 * mark a name tradable that neither the live catalog nor the snapshot lists.
 *
 * Ondo Global Markets is deliberately absent: its mint list sits behind a key
 * we do not hold and Jupiter search caps at 20 results, so it cannot be
 * enumerated honestly. Superstate (KYC wallets) and PreStocks (pre-IPO SPVs)
 * are out of scope by design.
 */

import { memo, memoPeek } from "@/lib/cache";
import snapshot from "@/lib/venues/catalog-snapshot.json";
import {
  extractXStocksProducts,
  indexCatalog,
  parseBackpackAssets,
  parseXStocksProducts,
  type BackpackAssetRow,
  type CatalogIndex,
  type CatalogIssuer,
  type CatalogToken,
} from "@/lib/venues/catalog-parse";

export const XSTOCKS_PRODUCTS_URL = "https://xstocks.com/us/products";
export const BACKPACK_ASSETS_URL = "https://api.backpack.exchange/api/v1/assets";

const TTL_MS = 60 * 60_000;

export type CatalogFeedStatus = {
  issuer: CatalogIssuer;
  /** "live" = fetched this process; "snapshot" = committed fallback; "off" = disabled by env. */
  source: "live" | "snapshot" | "off";
  count: number;
  fetchedAt: string;
  note: string | null;
};

export type SolanaCatalog = CatalogIndex & {
  tokens: CatalogToken[];
  feeds: CatalogFeedStatus[];
};

type Snapshot = { fetchedAt: string; xstocks: CatalogToken[]; backpack: CatalogToken[] };
const SNAPSHOT = snapshot as Snapshot;

function disabled(issuer: CatalogIssuer): boolean {
  const flag = issuer === "xstock" ? process.env.XSTOCKS_CATALOG_DISABLED : process.env.BACKPACK_CATALOG_DISABLED;
  return flag?.trim() === "1";
}

async function fetchText(url: string, accept: string): Promise<string> {
  const response = await fetch(url, {
    headers: { Accept: accept, "User-Agent": "Stocklana/1.0 (+https://stocklana.barelystable.dev)" },
    cache: "no-store",
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}

type Feed = { tokens: CatalogToken[]; fetchedAt: string };

async function loadXStocks(): Promise<Feed> {
  const html = await fetchText(XSTOCKS_PRODUCTS_URL, "text/html");
  const tokens = parseXStocksProducts(extractXStocksProducts(html));
  // A page redesign that hides __NEXT_DATA__ must not silently empty the catalog.
  if (tokens.length < 50) throw new Error(`xStocks page yielded ${tokens.length} tokens`);
  return { tokens, fetchedAt: new Date().toISOString() };
}

async function loadBackpack(): Promise<Feed> {
  const json = await fetchText(BACKPACK_ASSETS_URL, "application/json");
  const tokens = parseBackpackAssets(JSON.parse(json) as BackpackAssetRow[]);
  if (tokens.length < 50) throw new Error(`Backpack assets yielded ${tokens.length} Solana tokens`);
  return { tokens, fetchedAt: new Date().toISOString() };
}

async function loadFeed(issuer: CatalogIssuer): Promise<{ feed: Feed; status: CatalogFeedStatus }> {
  const fallback: Feed = {
    tokens: issuer === "xstock" ? SNAPSHOT.xstocks : SNAPSHOT.backpack,
    fetchedAt: SNAPSHOT.fetchedAt,
  };
  if (disabled(issuer)) {
    return { feed: { tokens: [], fetchedAt: fallback.fetchedAt }, status: { issuer, source: "off", count: 0, fetchedAt: fallback.fetchedAt, note: "disabled by env" } };
  }
  const key = `catalog:${issuer}`;
  try {
    const feed = await memo(key, { ttlMs: TTL_MS }, () => (issuer === "xstock" ? loadXStocks() : loadBackpack()));
    return { feed, status: { issuer, source: "live", count: feed.tokens.length, fetchedAt: feed.fetchedAt, note: null } };
  } catch (error) {
    const note = error instanceof Error ? error.message : String(error);
    return { feed: fallback, status: { issuer, source: "snapshot", count: fallback.tokens.length, fetchedAt: fallback.fetchedAt, note } };
  }
}

/** Both issuers merged, xStock mint preferred per ticker. Never throws. */
export async function loadSolanaCatalog(): Promise<SolanaCatalog> {
  return memo("catalog:merged", { ttlMs: 5 * 60_000 }, async () => {
    const [xstocks, backpack] = await Promise.all([loadFeed("xstock"), loadFeed("backpack")]);
    const tokens = [...xstocks.feed.tokens, ...backpack.feed.tokens];
    return { ...indexCatalog(tokens), tokens, feeds: [xstocks.status, backpack.status] };
  });
}

/** Snapshot-only view for synchronous callers (first pass before the live catalog lands). */
export function snapshotCatalog(): SolanaCatalog {
  const cached = memoPeek<SolanaCatalog>("catalog:merged");
  if (cached) return cached;
  const tokens = [...SNAPSHOT.xstocks, ...SNAPSHOT.backpack];
  return {
    ...indexCatalog(tokens),
    tokens,
    feeds: (["xstock", "backpack"] as const).map((issuer) => ({
      issuer,
      source: "snapshot" as const,
      count: issuer === "xstock" ? SNAPSHOT.xstocks.length : SNAPSHOT.backpack.length,
      fetchedAt: SNAPSHOT.fetchedAt,
      note: "live catalog not loaded yet",
    })),
  };
}

export function warmSolanaCatalog(): void {
  void loadSolanaCatalog().catch(() => undefined);
}
