/**
 * Deterministic InsiderIndex leg mapping from the captain's FMP *annual holdings* drop.
 *
 * The book is the latest FMP annual holdings (position value midpoints), NOT PelosiTracker
 * positions and NOT the truncated convenience brief. Per person we derive the ticker set, the
 * weight basis, and the resolved Solana leg per ticker in the fixed resolution order: xStock first,
 * then a verified Backpack on-chain `.US` token, else unmapped. Every mapped leg carries the mint
 * and the catalog evidence for it; a mint is only ever the catalog's own mint, never a guess and
 * never a lookalike. Unmapped is a first-class outcome and the unmapped share by weight is reported.
 *
 * Provenance is honest: where the book is transaction-derived (no annual position sizes) it is
 * treated as activity, never turned into weights. Where an annual book carries no ticker-bearing
 * rows the gap is recorded. This module is pure — no env, no fetch, no path aliases.
 */
import { baseIndexName } from "../fmp/index-name.ts";
import { normalizeTicker, preferredToken, type CatalogIndex, type CatalogToken } from "../venues/catalog-parse.ts";
import type { PoolEvidenceSource, PoolReadinessResult } from "./pool-evidence.ts";

/** Symmetry `MAX_SUPPORTED_TOKENS_PER_VAULT`. The vault-init builder throws past this; here it blocks. */
export const NATIVE_TOKEN_CAP = 100;
/** A one-name "index" is not an index; a vault needs at least two mapped legs. */
export const MIN_MAPPED_LEGS = 2;
export const INDEX_NETWORK = "mainnet-beta" as const;

/** Matches the Solana catalog issuer tag. xStock is preferred over a Backpack `.US` token. */
export type LegProvider = "xstock" | "backpack";

/** A definition is either one person's disclosed annual book or a constructed multi-member basket. */
export type IndexKind = "person" | "thematic";

export type WeightBasis =
  | "annual-holding-value-midpoint"
  | "thematic-multi-member-value"
  | "none-txn-derived"
  | "none-no-ticker-holdings";
/** The weight bases the vault-init builder will size legs from; others are not weightable. */
export const WEIGHTABLE_BASES: readonly WeightBasis[] = ["annual-holding-value-midpoint", "thematic-multi-member-value"];

export type HoldingRow = {
  name?: string | null;
  ticker: string | null;
  section?: string | null;
  value?: number | null;
  valueRange?: { min?: number | null; max?: number | null } | null;
};
export type TxnHoldingRow = {
  ticker: string | null;
  name?: string | null;
  tradeCount?: number | null;
  sides?: string[] | null;
  note?: string | null;
};
export type PersonBook = {
  slug: string;
  bioguideId: string | null;
  name: string;
  party?: string | null;
  state?: string | null;
  title?: string | null;
  fmpYear: number | null;
  bookSource: string | null;
  annualFetchComplete: boolean | null;
  holdings: HoldingRow[];
  holdingsFromTransactions: TxnHoldingRow[];
};

export type MappedLeg = {
  ticker: string;
  name: string | null;
  provider: LegProvider;
  symbol: string;
  mint: string;
  decimals: number;
  valueBasis: number;
  bookWeightBps: number;
  targetWeightBps: number;
  pool: PoolReadinessResult;
  vaultReady: boolean;
  evidence: {
    catalogIssuer: LegProvider;
    catalogSymbol: string;
    source: "solana-catalog";
    poolObservedAt: string | null;
    poolTvlUsd: number | null;
  };
};
export type UnmappedLeg = {
  ticker: string;
  name: string | null;
  valueBasis: number;
  bookWeightBps: number;
  reason: "no-solana-mint";
};
export type ActivityTicker = {
  ticker: string;
  name: string | null;
  tradeCount: number | null;
  mappedMint: string | null;
  provider: LegProvider | null;
};

/**
 * Provenance is a superset shape carried by both kinds; `kind` and `note` make the two honestly
 * distinguishable, and the thematic-only fields (basis, lane, methodology, members…) are present
 * only for a constructed basket. A person book never sets them; a thematic record never pretends to
 * a disclosed annual book (its person-book counters stay 0 / null).
 */
export type IndexProvenance = {
  kind: IndexKind;
  bookSource: string | null;
  fmpYear: number | null;
  annualFetchComplete: boolean | null;
  holdingsCount: number;
  tickerHoldingsCount: number;
  weightedTickerCount: number;
  unweightedTickerCount: number;
  note: string;
  // Thematic-only: a constructed multi-member research basket, never one person's book.
  basis?: "insiderindex-thematic";
  lane?: string;
  methodology?: string;
  memberCount?: number;
  members?: { slug: string; name: string; party?: string | null; state?: string | null; bioguideId?: string | null }[];
  constituentCount?: number;
};

/** Shared identity for a weighted index definition, independent of whether it is a person or basket. */
export type IndexIdentity = {
  kind: IndexKind;
  slug: string;
  bioguideId: string | null;
  name: string;
  indexId: string;
  indexName: string;
  symbol: string;
  network: typeof INDEX_NETWORK;
  nativeTokenCap: number;
};

export type PersonIndexDefinition = {
  kind: IndexKind;
  slug: string;
  bioguideId: string | null;
  name: string;
  indexId: string;
  indexName: string;
  symbol: string;
  network: typeof INDEX_NETWORK;
  weightBasis: WeightBasis;
  provenance: IndexProvenance;
  legs: MappedLeg[];
  unmapped: UnmappedLeg[];
  activity: ActivityTicker[];
  coverage: {
    tickerCount: number;
    mappedLegCount: number;
    vaultReadyLegCount: number;
    // Whole-book basis: `mappableByWeightBps` + `unmappedByWeightBps` = 10000 over every
    // positive-value ticker (mapped + unmapped). `mappableByWeightBps` is the CATALOG coverage.
    mappableByWeightBps: number;
    unmappedByWeightBps: number;
    // Whole-book basis too: the share of the FULL book (`bookWeightBps`) carried by legs that have
    // a real, tradable Raydium pool. This is the honest TRADABLE coverage and it is directly
    // comparable to `mappableByWeightBps`: `mappableByWeightBps - tradableByWeightBps` is exactly the
    // book weight that maps to a mint but has no usable pool behind it. Never re-weighted around.
    tradableByWeightBps: number;
    // Mapped-only basis: share of the renormalised mapped-leg weights (`targetWeightBps`, which
    // sum to 10000 across mapped legs) that is pool-ready. This is tradable coverage of the mapped
    // book. NOT comparable to the whole-book fields.
    poolReadyOfMappedBps: number;
  };
  nativeTokenCap: number;
  structurallyCreatable: boolean;
  blockedReasons: string[];
  status: "CREATABLE" | "WAIT_POOL_EVIDENCE" | "BLOCKED";
  // Per-vault deposit gate, driven by tradable coverage, NOT by creation. Default closed. The
  // global `VAULT_RELEASE.publicFundsEnabled` flag stays authoritative on top of this.
  depositsEnabled: boolean;
  depositReason: string;
};

/**
 * The per-vault deposit gate. Creation is cheap and ungated, but a deposit can only be honest when
 * EVERY mapped leg carries an observed tradable pool: otherwise weight lands on a leg that cannot be
 * rebalanced or exited to USDC, trapping a user's money. Default is closed; full tradable coverage
 * (all mapped legs vault-ready and the mapped weight 100% pool-ready) is required to open it, and
 * even then the release flag governs whether deposits actually go live.
 */
export function depositGate(args: {
  structurallyCreatable: boolean;
  mappedLegCount: number;
  vaultReadyLegCount: number;
  poolReadyOfMappedBps: number;
}): { enabled: boolean; reason: string } {
  if (!args.structurallyCreatable) return { enabled: false, reason: "vault-not-creatable" };
  if (args.mappedLegCount === 0) return { enabled: false, reason: "no-mapped-legs" };
  const notReady = args.mappedLegCount - args.vaultReadyLegCount;
  if (notReady > 0 || args.poolReadyOfMappedBps < 10_000) {
    return {
      enabled: false,
      reason: `${notReady}-of-${args.mappedLegCount}-mapped-legs-without-observed-tradable-pool; deposits stay closed so no weight is stranded from USDC exit`,
    };
  }
  return { enabled: true, reason: "all-mapped-legs-carry-an-observed-tradable-pool (still gated by VAULT_RELEASE.publicFundsEnabled)" };
}

/** Value used to weight a holding: the disclosed midpoint, else the band midpoint, else 0. */
export function holdingValue(row: HoldingRow): number {
  if (typeof row.value === "number" && Number.isFinite(row.value) && row.value > 0) return row.value;
  const min = row.valueRange?.min;
  const max = row.valueRange?.max;
  if (typeof min === "number" && typeof max === "number" && Number.isFinite(min) && Number.isFinite(max) && max >= min && max > 0) {
    return (min + max) / 2;
  }
  return 0;
}

/**
 * Largest-remainder integer bps over positive values, each entry floored to at least 1 bp and the
 * whole vector summing to exactly 10000. Order-stable; ties break to the earliest index.
 */
export function allocateBps(values: readonly number[]): number[] {
  const n = values.length;
  if (n === 0) return [];
  if (n > 10_000) throw new Error("Cannot allocate at least 1 bp to more than 10000 legs");
  const clean = values.map((v) => (Number.isFinite(v) && v > 0 ? v : 0));
  const total = clean.reduce((s, v) => s + v, 0);
  const share = total > 0 ? clean.map((v) => v / total) : clean.map(() => 1 / n);
  const bps = new Array<number>(n).fill(1);
  const remaining = 10_000 - n;
  const want = share.map((s) => s * remaining);
  let used = 0;
  for (let i = 0; i < n; i++) {
    const add = Math.floor(want[i]);
    bps[i] += add;
    used += add;
  }
  const order = want
    .map((w, i) => ({ i, frac: w - Math.floor(w) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; k < remaining - used; k++) bps[order[k % n].i]++;
  return bps;
}

/** `II` + up to six uppercase alphanumerics of the surname/name. Deterministic; ≤ 8 chars. */
export function indexSymbol(name: string): string {
  const words = name.replace(/,/g, " ").split(/\s+/).filter((w) => w && !/^(jr|sr|ii|iii|iv)\.?$/i.test(w));
  const last = words.at(-1) ?? words[0] ?? "INDEX";
  const core = last.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6) || "INDEX";
  return `II${core}`;
}

function nameParts(book: PersonBook) {
  const words = book.name.replace(/,/g, " ").split(/\s+/).filter((w) => w && !/^(jr|sr|ii|iii|iv)\.?$/i.test(w));
  return { id: book.bioguideId ?? book.slug, name: words.join(" "), firstName: words[0] ?? null, lastName: words.length > 1 ? words.at(-1)! : null };
}

/** Only a book with no annual disclosure at all is transaction-derived. An annual book with no
 *  ticker-bearing rows is a different, separately-recorded gap, not activity. */
function isTxnDerived(book: PersonBook): boolean {
  return book.bookSource === "txn-derived";
}

function resolveTicker(catalog: CatalogIndex, ticker: string): CatalogToken | null {
  return preferredToken(catalog, ticker);
}

/** Aggregate ticker → { name, value } from annual holdings; only positive-value ticker rows weight. */
function aggregateTickers(book: PersonBook): { ticker: string; name: string | null; value: number }[] {
  const byTicker = new Map<string, { ticker: string; name: string | null; value: number }>();
  for (const row of book.holdings) {
    if (!row.ticker) continue;
    const ticker = normalizeTicker(row.ticker);
    const value = holdingValue(row);
    const existing = byTicker.get(ticker);
    if (existing) existing.value += value;
    else byTicker.set(ticker, { ticker, name: row.name ?? null, value });
  }
  return [...byTicker.values()];
}

export function derivePersonIndex(book: PersonBook, catalog: CatalogIndex, poolSource: PoolEvidenceSource): PersonIndexDefinition {
  const parts = nameParts(book);
  const indexId = `insiderindex-${book.slug}`;
  const indexName = `${baseIndexName(parts)} · InsiderIndex`;
  const symbol = indexSymbol(book.name);
  const holdingsCount = book.holdings.length;
  const tickerHoldingsCount = book.holdings.filter((h) => h.ticker).length;

  const base: IndexIdentity = {
    kind: "person",
    slug: book.slug,
    bioguideId: book.bioguideId,
    name: book.name,
    indexId,
    indexName,
    symbol,
    network: INDEX_NETWORK,
    nativeTokenCap: NATIVE_TOKEN_CAP,
  };

  // Transaction-derived books are activity, never position sizes: resolve tickers for information
  // only, never a weight, and block vault creation with the reason recorded.
  if (isTxnDerived(book)) {
    const activity: ActivityTicker[] = book.holdingsFromTransactions
      .filter((r) => r.ticker)
      .map((r) => {
        const token = resolveTicker(catalog, r.ticker!);
        return {
          ticker: normalizeTicker(r.ticker!),
          name: r.name ?? null,
          tradeCount: typeof r.tradeCount === "number" ? r.tradeCount : null,
          mappedMint: token?.mint ?? null,
          provider: (token?.issuer as LegProvider | undefined) ?? null,
        };
      });
    return {
      ...base,
      weightBasis: "none-txn-derived",
      provenance: {
        kind: "person",
        bookSource: book.bookSource,
        fmpYear: book.fmpYear,
        annualFetchComplete: book.annualFetchComplete,
        holdingsCount,
        tickerHoldingsCount,
        weightedTickerCount: 0,
        unweightedTickerCount: 0,
        note: "Transaction-derived activity only; no annual position sizes, so no weights are assigned.",
      },
      legs: [],
      unmapped: [],
      activity,
      coverage: { tickerCount: 0, mappedLegCount: 0, vaultReadyLegCount: 0, mappableByWeightBps: 0, unmappedByWeightBps: 0, tradableByWeightBps: 0, poolReadyOfMappedBps: 0 },
      structurallyCreatable: false,
      blockedReasons: ["txn-derived-book"],
      status: "BLOCKED",
      ...blockedDeposit("txn-derived-book"),
    };
  }

  const aggregated = aggregateTickers(book);
  const weighted = aggregated.filter((t) => t.value > 0);
  const unweightedTickerCount = aggregated.length - weighted.length;

  // No ticker-bearing annual rows to weight: an annual book that is all real estate / cash / funds.
  if (weighted.length === 0) {
    return {
      ...base,
      weightBasis: "none-no-ticker-holdings",
      provenance: {
        kind: "person",
        bookSource: book.bookSource,
        fmpYear: book.fmpYear,
        annualFetchComplete: book.annualFetchComplete,
        holdingsCount,
        tickerHoldingsCount,
        weightedTickerCount: 0,
        unweightedTickerCount,
        note: "Annual book carries no ticker-bearing position with a positive value.",
      },
      legs: [],
      unmapped: [],
      activity: [],
      coverage: { tickerCount: 0, mappedLegCount: 0, vaultReadyLegCount: 0, mappableByWeightBps: 0, unmappedByWeightBps: 0, tradableByWeightBps: 0, poolReadyOfMappedBps: 0 },
      structurallyCreatable: false,
      blockedReasons: ["no-ticker-holdings-in-annual-book"],
      status: "BLOCKED",
      ...blockedDeposit("no-ticker-holdings-in-annual-book"),
    };
  }

  const provenance: IndexProvenance = {
    kind: "person",
    bookSource: book.bookSource,
    fmpYear: book.fmpYear,
    annualFetchComplete: book.annualFetchComplete,
    holdingsCount,
    tickerHoldingsCount,
    weightedTickerCount: weighted.length,
    unweightedTickerCount,
    note: book.annualFetchComplete === false
      ? "Annual fetch incomplete: fewer ticker rows than holdings; mapping covers the disclosed rows only."
      : "Annual holdings mapped by disclosed position-value midpoints.",
  };
  return buildWeightedIndexDefinition({
    identity: base,
    weighted: weighted.map((t) => ({ ticker: t.ticker, name: t.name, value: t.value })),
    weightBasis: "annual-holding-value-midpoint",
    provenance,
    activity: [],
    catalog,
    poolSource,
  });
}

/** A blocked definition never opens deposits; the reason mirrors the block. */
function blockedDeposit(reason: string): { depositsEnabled: false; depositReason: string } {
  return { depositsEnabled: false, depositReason: `blocked:${reason}` };
}

/**
 * Shared derivation for any weighted index (a person's annual book or a constructed multi-member
 * basket). Resolves each ticker through the same Solana catalog (xStock → verified Backpack `.US` →
 * unmapped), renormalises target weights across mapped legs only, runs the identical Raydium
 * pool-readiness evaluation, records catalog coverage vs tradable coverage, enforces the native leg
 * cap (blocks, never truncates), and derives the closed-by-default deposit gate. There is exactly
 * one mapping/readiness path; the caller only supplies identity, weighted rows, and provenance.
 */
export function buildWeightedIndexDefinition(args: {
  identity: IndexIdentity;
  weighted: readonly { ticker: string; name: string | null; value: number }[];
  weightBasis: WeightBasis;
  provenance: IndexProvenance;
  activity?: ActivityTicker[];
  catalog: CatalogIndex;
  poolSource: PoolEvidenceSource;
}): PersonIndexDefinition {
  const { identity, weightBasis, provenance, catalog, poolSource } = args;
  const weighted = args.weighted.filter((t) => Number.isFinite(t.value) && t.value > 0);
  const base = { ...identity };

  // Book weights over ALL positive-value tickers (mapped + unmapped) so the unmapped share is honest.
  const bookBps = allocateBps(weighted.map((t) => t.value));
  const resolved = weighted.map((t, i) => ({ ...t, bookWeightBps: bookBps[i], token: resolveTicker(catalog, t.ticker) }));
  const mappedRows = resolved.filter((r) => r.token);
  const unmappedRows = resolved.filter((r) => !r.token);

  // Target weights are renormalised across the mapped legs only (never around an unmapped leg
  // silently: the dropped share is reported as `unmappedByWeightBps`).
  const targetBps = allocateBps(mappedRows.map((r) => r.value));
  const legs: MappedLeg[] = mappedRows.map((r, i) => {
    const token = r.token!;
    const pool = poolSource.readiness(token.mint);
    const provider = token.issuer as LegProvider;
    return {
      ticker: r.ticker,
      name: r.name,
      provider,
      symbol: token.symbol,
      mint: token.mint,
      decimals: token.decimals,
      valueBasis: r.value,
      bookWeightBps: r.bookWeightBps,
      targetWeightBps: targetBps[i],
      pool,
      vaultReady: pool.status === "observed",
      evidence: {
        catalogIssuer: provider,
        catalogSymbol: token.symbol,
        source: "solana-catalog",
        poolObservedAt: pool.pool?.observedAt ?? null,
        poolTvlUsd: pool.pool?.tvlUsd ?? null,
      },
    };
  });
  const unmapped: UnmappedLeg[] = unmappedRows.map((r) => ({
    ticker: r.ticker,
    name: r.name,
    valueBasis: r.value,
    bookWeightBps: r.bookWeightBps,
    reason: "no-solana-mint",
  }));

  const mappableByWeightBps = legs.reduce((s, l) => s + l.bookWeightBps, 0);
  const vaultReadyLegCount = legs.filter((l) => l.vaultReady).length;
  // Whole-book tradable coverage: only legs with a real, tradable pool contribute; a not-ready leg
  // (thin or absent pool) never adds to tradable coverage even though it still counts as mapped.
  const tradableByWeightBps = legs.filter((l) => l.vaultReady).reduce((s, l) => s + l.bookWeightBps, 0);
  const poolReadyOfMappedBps = legs.filter((l) => l.vaultReady).reduce((s, l) => s + l.targetWeightBps, 0);

  const blockedReasons: string[] = [];
  if (legs.length < MIN_MAPPED_LEGS) blockedReasons.push("too-few-mapped-legs");
  if (legs.length > identity.nativeTokenCap) blockedReasons.push("native-token-cap-exceeded");
  const structurallyCreatable = blockedReasons.length === 0;
  const status: PersonIndexDefinition["status"] = !structurallyCreatable
    ? "BLOCKED"
    : vaultReadyLegCount >= MIN_MAPPED_LEGS
      ? "CREATABLE"
      : "WAIT_POOL_EVIDENCE";
  const deposit = depositGate({ structurallyCreatable, mappedLegCount: legs.length, vaultReadyLegCount, poolReadyOfMappedBps });

  return {
    ...base,
    weightBasis,
    provenance,
    legs,
    unmapped,
    activity: args.activity ?? [],
    coverage: {
      tickerCount: weighted.length,
      mappedLegCount: legs.length,
      vaultReadyLegCount,
      mappableByWeightBps,
      unmappedByWeightBps: 10_000 - mappableByWeightBps,
      tradableByWeightBps,
      poolReadyOfMappedBps,
    },
    nativeTokenCap: identity.nativeTokenCap,
    structurallyCreatable,
    blockedReasons,
    status,
    depositsEnabled: deposit.enabled,
    depositReason: deposit.reason,
  };
}
