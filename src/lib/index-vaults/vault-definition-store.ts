/** Persisted research definitions. NAV vault identity/readiness comes from the on-chain NAV PDA,
 * not the historical vault_address/share_mint columns retained by these database contracts. */
import type { SupabaseClient } from "@supabase/supabase-js";
import { snapshotCatalog } from "../venues/solana-catalog.ts";
import type { CatalogIndex } from "../venues/catalog-parse.ts";

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

export function enrichPublicVaultLegSymbols(legs: readonly PublicVaultLeg[], catalog: Pick<CatalogIndex, "byMint">): PublicVaultLeg[] {
  return legs.map(leg => leg.symbol ? leg : { ...leg, symbol: catalog.byMint.get(leg.mint)?.symbol ?? leg.symbol });
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

/** Service-role only; returns derived definitions, never raw books. */
export async function readPublicVaultDefinitions(db: SupabaseClient): Promise<PublicVaultDefinition[]> {
  const { data, error } = await db
    .from("insiderindex_vault_definitions")
    .select("index_id,kind,person_slug,bioguide_id,name,symbol,status,network,weight_basis,deposits_enabled,deposit_reason,coverage,provenance,legs,unmapped,vault_address,share_mint,updated_at")
    .order("index_id");
  if (error || !data) throw new Error(`Vault definition directory read failed (${error?.code ?? "storage"})`);
  const catalog = snapshotCatalog();
  return (data as PublicVaultRow[]).map(row => publicDefinition(row, catalog));
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
/** NAV's multi-vault keeper enumerates these IDs, then reads each on-chain NAV vault. */
export async function readVaultDefinitions(db: SupabaseClient): Promise<VaultDefinitionSummary[]> {
  const { data, error } = await db.rpc("read_insiderindex_vault_definitions");
  if (error) throw new Error(`Vault definitions read failed (${error.code ?? "storage"})`);
  return (data as VaultDefinitionSummary[] | null) ?? [];
}
