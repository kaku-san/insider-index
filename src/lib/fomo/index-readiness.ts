// Pure rules for when a basket is honest enough to show as an "index".
// Safe to import from client components: no server dependencies.
import type { Disclosure, PersonIndex } from "@/lib/disclosures/types";

export const INDEX_RULES = {
  /** Disclosures older than this do not count toward a crowd index. */
  windowDays: 90,
  /**
   * A single filer's basket: their disclosed book, restricted to names we can
   * route somewhere (xStock or Backpack). The only gate is that the book holds
   * at least this many tradable names — the profile itself renders with one.
   */
  person: { minNames: 2 },
  /** A basket built from many filers (Capitol Buys, Insider Buys). */
  crowd: { minFilers: 5, minNames: 3 },
} as const;

export const CROWD_INDEX_PREFIX = "idx-crowd-";

export type IndexReadiness = {
  ready: boolean;
  /** "crowd" = many filers in one basket; "person" = one filer's disclosed book. */
  shape: "crowd" | "person";
  filers: number;
  buys: number;
  /** Tradable names in the basket (any venue). */
  names: number;
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

/** A buy on a name we can route to some venue, inside the window. */
export function isCountableBuy(row: Disclosure, now = Date.now()): boolean {
  return row.side === "buy" && row.tradeEligible && row.venue !== "none" && withinWindow(row, now);
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function indexReadiness(index: PersonIndex, disclosures: Disclosure[], now = Date.now()): IndexReadiness {
  const names = index.constituents.length;
  if (isCrowdIndex(index)) {
    const rows = disclosures.filter((row) => row.kind === index.kind && isCountableBuy(row, now));
    const filers = new Set(rows.map((row) => row.profileId)).size;
    const { minFilers, minNames } = INDEX_RULES.crowd;
    const missing: string[] = [];
    if (filers < minFilers) missing.push(`${plural(minFilers - filers, "more filer")} buying`);
    if (names < minNames) missing.push(`${plural(minNames - names, "more tradable name")}`);
    return {
      ready: missing.length === 0,
      shape: "crowd",
      filers,
      buys: rows.length,
      names,
      need: missing.length ? `Needs ${missing.join(" and ")} in the last ${INDEX_RULES.windowDays} days.` : null,
    };
  }
  const rows = disclosures.filter((row) => row.profileId === index.profileId && isCountableBuy(row, now));
  const { minNames } = INDEX_RULES.person;
  const missing: string[] = [];
  if (names < minNames) missing.push(`${plural(minNames - names, "more tradable name")} in their disclosed book`);
  return {
    ready: missing.length === 0,
    shape: "person",
    filers: 1,
    buys: rows.length,
    names,
    need: missing.length ? `Needs ${missing.join(" and ")} before it can be bought as a basket.` : null,
  };
}

export function readinessSummary(r: IndexReadiness): string {
  if (r.shape === "crowd") {
    return `${[plural(r.filers, "filer"), plural(r.buys, "buy"), plural(r.names, "tradable name")].join(" · ")} · ${INDEX_RULES.windowDays}d`;
  }
  return `${plural(r.names, "tradable name")} · ${plural(r.buys, "buy")} in ${INDEX_RULES.windowDays}d`;
}
