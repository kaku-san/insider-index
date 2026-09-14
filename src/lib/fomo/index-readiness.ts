// Pure rules for when a basket is honest enough to show as an "index".
// Safe to import from client components: no server dependencies.
import type { Disclosure, PersonIndex } from "@/lib/disclosures/types";

export const INDEX_RULES = {
  /** Disclosures older than this do not count toward an index. */
  windowDays: 90,
  /** A single filer's basket. */
  person: { minXStocks: 2, minBuys: 2 },
  /** A basket built from many filers (Capitol Buys, Insider Buys). */
  crowd: { minFilers: 5, minXStocks: 3 },
} as const;

export const CROWD_INDEX_PREFIX = "idx-crowd-";

export type IndexReadiness = {
  ready: boolean;
  /** "crowd" = many filers in one basket; "person" = one filer's disclosed book. */
  shape: "crowd" | "person";
  filers: number;
  buys: number;
  xstocks: number;
  /** Plain-English reason the index is not ready. Null when ready. */
  need: string | null;
};

export function isCrowdIndex(index: Pick<PersonIndex, "id">): boolean {
  return index.id.startsWith(CROWD_INDEX_PREFIX);
}

export function withinWindow(row: Pick<Disclosure, "filedAt" | "transactionDate">, now = Date.now()): boolean {
  const at = Date.parse(row.filedAt || row.transactionDate);
  if (!Number.isFinite(at)) return false;
  return now - at <= INDEX_RULES.windowDays * 86_400_000;
}

export function isCountableBuy(row: Disclosure, now = Date.now()): boolean {
  return row.side === "buy" && row.tradeEligible && Boolean(row.xstockMint) && withinWindow(row, now);
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function indexReadiness(index: PersonIndex, disclosures: Disclosure[], now = Date.now()): IndexReadiness {
  const xstocks = index.constituents.length;
  if (isCrowdIndex(index)) {
    const rows = disclosures.filter((row) => row.kind === index.kind && isCountableBuy(row, now));
    const filers = new Set(rows.map((row) => row.profileId)).size;
    const { minFilers, minXStocks } = INDEX_RULES.crowd;
    const missing: string[] = [];
    if (filers < minFilers) missing.push(`${plural(minFilers - filers, "more filer")} buying`);
    if (xstocks < minXStocks) missing.push(`${plural(minXStocks - xstocks, "more xStock")}`);
    return {
      ready: missing.length === 0,
      shape: "crowd",
      filers,
      buys: rows.length,
      xstocks,
      need: missing.length ? `Needs ${missing.join(" and ")} in the last ${INDEX_RULES.windowDays} days.` : null,
    };
  }
  const rows = disclosures.filter((row) => row.profileId === index.profileId && isCountableBuy(row, now));
  const { minXStocks, minBuys } = INDEX_RULES.person;
  const missing: string[] = [];
  if (rows.length < minBuys) missing.push(plural(minBuys - rows.length, "more allowlisted buy"));
  if (xstocks < minXStocks) missing.push(plural(minXStocks - xstocks, "more xStock"));
  return {
    ready: missing.length === 0,
    shape: "person",
    filers: 1,
    buys: rows.length,
    xstocks,
    need: missing.length ? `Needs ${missing.join(" and ")} before this is a real basket.` : null,
  };
}

export function readinessSummary(r: IndexReadiness): string {
  const parts = r.shape === "crowd" ? [plural(r.filers, "filer"), plural(r.buys, "buy"), plural(r.xstocks, "xStock")] : [plural(r.buys, "buy"), plural(r.xstocks, "xStock")];
  return `${parts.join(" · ")} · ${INDEX_RULES.windowDays}d`;
}
