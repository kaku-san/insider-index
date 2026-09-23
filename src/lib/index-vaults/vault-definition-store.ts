/**
 * Backend store + keeper bridge for InsiderIndex vault definitions.
 *
 * The derivation is persisted per vault in Supabase (migration 202609160001): the keeper reads its
 * target weights and eligibility inputs from that record, not from local files. Definitions are
 * upserted through the owner RPC (updated in place, versioned by hash + source sha256). This module
 * builds the publish document from the pure derivation and exposes the keeper's target reader,
 * which hands the persisted vault legs straight to the shared `kakuSanDrift` eligibility math.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { snapshotCatalog } from "../venues/solana-catalog.ts";
import type { CatalogIndex } from "../venues/catalog-parse.ts";
import { kakuSanDrift } from "./kaku-san-rebalance.ts";
import type { PersonIndexDefinition } from "./person-index-map.ts";
import { buildPersonVaultInit, estimateVaultCost, type PersonVaultInit } from "./person-vault-init.ts";
import { VAULT_RELEASE } from "./release.ts";

export type VaultDefinitionSource = { zip: string | null; sha256: string | null; generatedAt: string };
export type VaultDefinitionDocument = {
  source: VaultDefinitionSource;
  network: string;
  definitions: Record<string, unknown>[];
};

function legForDb(leg: PersonIndexDefinition["legs"][number]) {
  return {
    ticker: leg.ticker,
    symbol: leg.symbol,
    provider: leg.provider,
    mint: leg.mint,
    decimals: leg.decimals,
    bookWeightBps: leg.bookWeightBps,
    targetWeightBps: leg.targetWeightBps,
    vaultReady: leg.vaultReady,
    pool: { status: leg.pool.status, pool: leg.pool.pool?.pool ?? null, tvlUsd: leg.pool.pool?.tvlUsd ?? null, observedAt: leg.pool.pool?.observedAt ?? null },
  };
}
function vaultLegForDb(leg: PersonVaultInit["legs"][number]) {
  return { ticker: leg.ticker, mint: leg.mint, provider: leg.provider, decimals: leg.decimals, pool: leg.pool, kind: leg.kind, tvlUsd: leg.tvlUsd, targetWeightBps: leg.targetWeightBps };
}

/** Assemble one persisted definition. The vault-init (pool-ready composition + cost) is attached
 * only when the vault is creatable; otherwise the reason and an estimate are still recorded. */
export function definitionForDb(definition: PersonIndexDefinition): Record<string, unknown> {
  let init: PersonVaultInit | null = null;
  try {
    init = buildPersonVaultInit(definition);
  } catch {
    init = null;
  }
  return {
    indexId: definition.indexId,
    // A thematic definition is a constructed multi-member basket, not a person: `kind` keeps the
    // persisted record honest even though the person-slug column is reused for the identity slug.
    kind: definition.kind,
    personSlug: definition.slug,
    bioguideId: definition.bioguideId,
    network: definition.network,
    name: definition.indexName,
    symbol: definition.symbol,
    weightBasis: definition.weightBasis,
    status: definition.status,
    structurallyCreatable: definition.structurallyCreatable,
    blockedReasons: definition.blockedReasons,
    // Per-vault deposit gate (closed by default, driven by tradable coverage) AND the authoritative
    // release flag. Creation being possible never opens deposits.
    deposits: {
      enabled: definition.depositsEnabled,
      reason: definition.depositReason,
      releaseGated: !VAULT_RELEASE.publicFundsEnabled,
      effectiveEnabled: definition.depositsEnabled && VAULT_RELEASE.publicFundsEnabled,
    },
    // `book_source` stays its own queryable column (keeper/reports filter on it); the full
    // provenance object is persisted alongside so the DB record shows book honesty (incomplete
    // annual fetch, ticker-row counts, weighted share) without re-reading the source zip.
    bookSource: definition.provenance.bookSource,
    provenance: definition.provenance,
    nativeTokenCap: definition.nativeTokenCap,
    hostEntryFeeBps: 25,
    hostExitFeeBps: 0,
    legs: definition.legs.map(legForDb),
    vaultLegs: init ? init.legs.map(vaultLegForDb) : [],
    poolExcludedLegs: init ? init.poolExcludedLegs : [],
    unmapped: definition.unmapped,
    coverage: definition.coverage,
    cost: init ? init.cost : estimateVaultCost(definition.legs.length),
    keeper: init
      ? init.keeper
      : { pubkey: null, automationEnabled: false, targetsSource: "insiderindex_vault_definitions", note: "Not creatable yet; no keeper targets." },
  };
}

export function buildVaultDefinitionDocument(
  definitions: readonly PersonIndexDefinition[],
  source: VaultDefinitionSource,
  network = "mainnet-beta",
): VaultDefinitionDocument {
  return { source, network, definitions: definitions.map(definitionForDb) };
}

/** Owner RPC upserts the whole set in one transaction. Never writes raw books or invented series. */
export async function publishVaultDefinitions(db: SupabaseClient, document: VaultDefinitionDocument): Promise<{ total: number; changed: number }> {
  const payload = JSON.stringify(document);
  const { data, error } = await db.rpc("publish_insiderindex_vault_definitions", { p_document: payload });
  if (error) throw new Error(`Vault definition publication failed (${error.code ?? "storage"}); apply migration 202609160001`);
  const result = (data ?? {}) as { total?: number; changed?: number };
  return { total: result.total ?? 0, changed: result.changed ?? 0 };
}

/** A persisted, pool-ready vault leg: the DB stores the Raydium pool + kind + decimals alongside the
 *  target weight, so creation builds transactions from the record, never re-derived from constants. */
export type PersistedVaultLeg = {
  ticker: string;
  mint: string;
  provider?: string | null;
  decimals: number;
  pool: string;
  kind: string;
  tvlUsd?: number | null;
  targetWeightBps: number;
};
export type PersistedVaultDefinition = {
  indexId: string;
  kind?: string | null;
  personSlug?: string | null;
  network?: string | null;
  name: string;
  symbol: string;
  status: string;
  depositsEnabled?: boolean | null;
  depositReason?: string | null;
  weightBasis?: string | null;
  nativeTokenCap?: number | null;
  structurallyCreatable?: boolean | null;
  blockedReasons?: string[];
  bookSource: string | null;
  provenance: Record<string, unknown>;
  hostEntryFeeBps?: number | null;
  hostExitFeeBps?: number | null;
  coverage?: Record<string, unknown> | null;
  poolExcludedLegs?: { ticker: string; mint: string; reason: string }[];
  vaultAddress: string | null;
  shareMint: string | null;
  vaultLegs: PersistedVaultLeg[];
  keeper: { pubkey: string | null; automationEnabled: boolean };
  lastRebalanceAt?: string | null;
  lastRebalanceResult?: Record<string, unknown> | null;
  definitionVersion?: number;
};

export type PublicVaultLeg = {
  ticker: string;
  name?: string | null;
  symbol?: string | null;
  provider: "xstock" | "backpack";
  mint: string;
  bookWeightBps: number;
  targetWeightBps: number;
  vaultReady: boolean;
};

export type PublicVaultDefinition = {
  indexId: string;
  kind: "person" | "thematic";
  personSlug: string;
  bioguideId: string | null;
  name: string;
  symbol: string;
  status: "CREATABLE" | "WAIT_POOL_EVIDENCE" | "BLOCKED";
  network: "mainnet-beta" | "devnet" | null;
  weightBasis: string;
  depositsEnabled: boolean;
  /** Per-index public-surface eligibility, added by the public response projector. */
  publicFundsEnabled?: boolean;
  depositReason: string | null;
  coverage: {
    tickerCount?: number;
    mappedLegCount?: number;
    vaultReadyLegCount?: number;
    mappableByWeightBps?: number;
    tradableByWeightBps?: number;
    poolReadyOfMappedBps?: number;
  };
  provenance: {
    kind?: "person" | "thematic";
    fmpYear?: number | null;
    note?: string;
    memberCount?: number;
  };
  legs: PublicVaultLeg[];
  unmapped: { ticker: string; name?: string | null; bookWeightBps?: number; reason?: string }[];
  vaultAddress: string | null;
  shareMint: string | null;
  updatedAt: string;
};

type PublicVaultRow = {
  index_id: string;
  kind: "person" | "thematic";
  person_slug: string;
  bioguide_id: string | null;
  name: string;
  symbol: string;
  status: PublicVaultDefinition["status"];
  network: string | null;
  weight_basis: string;
  deposits_enabled: boolean;
  deposit_reason: string | null;
  coverage: PublicVaultDefinition["coverage"];
  provenance: PublicVaultDefinition["provenance"];
  legs: PublicVaultLeg[];
  unmapped: PublicVaultDefinition["unmapped"];
  vault_address: string | null;
  share_mint: string | null;
  updated_at: string;
};

export function enrichPublicVaultLegSymbols(
  legs: readonly PublicVaultLeg[],
  catalog: Pick<CatalogIndex, "byMint">,
): PublicVaultLeg[] {
  return legs.map((leg) => leg.symbol
    ? leg
    : { ...leg, symbol: catalog.byMint.get(leg.mint)?.symbol ?? leg.symbol });
}

function publicDefinition(row: PublicVaultRow, catalog: Pick<CatalogIndex, "byMint">): PublicVaultDefinition {
  return {
    indexId: row.index_id,
    kind: row.kind,
    personSlug: row.person_slug,
    bioguideId: row.bioguide_id,
    name: row.name,
    symbol: row.symbol,
    status: row.status,
    network: row.network === "mainnet-beta" || row.network === "devnet" ? row.network : null,
    weightBasis: row.weight_basis,
    depositsEnabled: row.deposits_enabled,
    depositReason: row.deposit_reason,
    coverage: row.coverage ?? {},
    provenance: row.provenance ?? {},
    legs: enrichPublicVaultLegSymbols(row.legs ?? [], catalog),
    unmapped: row.unmapped ?? [],
    vaultAddress: row.vault_address,
    shareMint: row.share_mint,
    updatedAt: row.updated_at,
  };
}

/** Public presentation reader. Service-role only; returns derived definitions, never raw books. */
export async function readPublicVaultDefinitions(db: SupabaseClient): Promise<PublicVaultDefinition[]> {
  const { data, error } = await db
    .from("insiderindex_vault_definitions")
    .select("index_id,kind,person_slug,bioguide_id,name,symbol,status,network,weight_basis,deposits_enabled,deposit_reason,coverage,provenance,legs,unmapped,vault_address,share_mint,updated_at")
    .order("index_id");
  if (error || !data) throw new Error(`Vault definition directory read failed (${error?.code ?? "storage"})`);
  const catalog = snapshotCatalog();
  return (data as PublicVaultRow[]).map((row) => publicDefinition(row, catalog));
}

export async function readPublicVaultDefinition(db: SupabaseClient, indexId: string): Promise<PublicVaultDefinition | null> {
  const { data, error } = await db
    .from("insiderindex_vault_definitions")
    .select("index_id,kind,person_slug,bioguide_id,name,symbol,status,network,weight_basis,deposits_enabled,deposit_reason,coverage,provenance,legs,unmapped,vault_address,share_mint,updated_at")
    .eq("index_id", indexId)
    .maybeSingle();
  if (error) throw new Error(`Vault definition read failed (${error.code ?? "storage"})`);
  if (!data) return null;
  return publicDefinition(data as PublicVaultRow, snapshotCatalog());
}

export async function readVaultDefinition(db: SupabaseClient, indexId: string): Promise<PersistedVaultDefinition | null> {
  const { data, error } = await db.rpc("read_insiderindex_vault_definition", { p_index_id: indexId });
  if (error) throw new Error(`Vault definition read failed (${error.code ?? "storage"})`);
  return (data as PersistedVaultDefinition | null) ?? null;
}

export type VaultDefinitionSummary = {
  indexId: string;
  name: string;
  symbol: string;
  status: string;
  structurallyCreatable: boolean;
  coverage: Record<string, unknown>;
  vaultAddress: string | null;
  shareMint: string | null;
};

/** List every persisted definition (id, name, status, coverage, live vault) for the admin selector. */
export async function readVaultDefinitions(db: SupabaseClient): Promise<VaultDefinitionSummary[]> {
  const { data, error } = await db.rpc("read_insiderindex_vault_definitions");
  if (error) throw new Error(`Vault definitions read failed (${error.code ?? "storage"})`);
  return (data as VaultDefinitionSummary[] | null) ?? [];
}

/** Write the captain-authorised creation (vault address + share mint + receipt) back onto the record.
 *  Idempotent and refuses to clobber a different already-recorded vault (owner RPC enforces this). */
export async function writeVaultCreation(
  db: SupabaseClient,
  indexId: string,
  vaultAddress: string,
  shareMint: string,
  receipt: Record<string, unknown>,
): Promise<void> {
  const { error } = await db.rpc("set_insiderindex_vault_address", {
    p_index_id: indexId, p_vault_address: vaultAddress, p_share_mint: shareMint, p_receipt: receipt,
  });
  if (error) throw new Error(`Vault creation write-back failed (${error.code ?? "storage"}): ${error.message ?? "unknown"}`);
}

/**
 * Keeper write-back: record one tick's outcome onto the definition row (migration 202609180001).
 * A dry run records mode:"dry-run" and never claims a rebalance; only a broadcast execute tick
 * records a rebalance with signatures. The server-side RPC refuses a row with no created vault.
 */
export async function recordRebalanceOutcome(
  db: SupabaseClient,
  indexId: string,
  result: Record<string, unknown>,
): Promise<void> {
  const mode = result.mode;
  if (mode !== "dry-run" && mode !== "execute") throw new Error("Rebalance outcome must carry mode dry-run or execute");
  const { error } = await db.rpc("record_insiderindex_vault_rebalance", { p_index_id: indexId, p_result: JSON.stringify(result) });
  if (error) throw new Error(`Rebalance outcome write failed (${error.code ?? "storage"}); apply migration 202609180001`);
}

/**
 * Keeper target reader: the persisted vault legs, shaped for the shared `kakuSanDrift` eligibility
 * math. The keeper never re-derives weights; it trusts the versioned DB record. A vault with no
 * live address or that is not creatable yields no targets.
 */
export function keeperTargets(record: PersistedVaultDefinition): { ticker: string; mint: string; targetWeightBps: number }[] {
  if (record.status !== "CREATABLE") return [];
  return record.vaultLegs.map((l) => ({ ticker: l.ticker, mint: l.mint, targetWeightBps: l.targetWeightBps }));
}

/** Drift of a live vault against its persisted DB targets, via the shared eligibility module. */
export function vaultDriftFromRecord(
  record: PersistedVaultDefinition,
  vault: Parameters<typeof kakuSanDrift>[0],
): ReturnType<typeof kakuSanDrift> {
  const targets = keeperTargets(record);
  if (!targets.length) throw new Error(`NO_KEEPER_TARGETS: ${record.indexId} is ${record.status}`);
  return kakuSanDrift(vault, targets);
}
