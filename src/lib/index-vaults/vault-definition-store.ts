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

export type PersistedVaultDefinition = {
  indexId: string;
  status: string;
  bookSource: string | null;
  provenance: Record<string, unknown>;
  vaultAddress: string | null;
  shareMint: string | null;
  vaultLegs: { ticker: string; mint: string; targetWeightBps: number }[];
  keeper: { pubkey: string | null; automationEnabled: boolean };
};

export async function readVaultDefinition(db: SupabaseClient, indexId: string): Promise<PersistedVaultDefinition | null> {
  const { data, error } = await db.rpc("read_insiderindex_vault_definition", { p_index_id: indexId });
  if (error) throw new Error(`Vault definition read failed (${error.code ?? "storage"})`);
  return (data as PersistedVaultDefinition | null) ?? null;
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
