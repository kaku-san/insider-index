/**
 * Per-person vault-initialisation input, built from a derived InsiderIndex definition.
 *
 * One Symmetry V3 vault plus one share mint per person index: honest enter/exit (25 bps in, 0 host
 * out), USDC-only exit, rebalanced by an automated keeper. Legs are the mapped xStock/Backpack
 * mints that also carry observed Raydium pool evidence (the Symmetry oracle prerequisite). The
 * native leg cap is disclosed and enforced: requesting more legs than the cap throws — the book is
 * never silently truncated to fit. This module builds the reviewable input and a dry-run cost
 * preview only; it never signs, sends, or holds a key.
 */
import type { AddOrEditTokenInput, OracleInput } from "@symmetry-hq/sdk";
import type { CostPreview } from "./adapter-contract.ts";
import { address, weightsValid } from "./amounts.ts";
import { HOST_ENTRY_FEE_BPS, HOST_EXIT_FEE_BPS } from "./fees.ts";
import { assertNativeTokenCap, KAKU_SAN_NATIVE_TOKEN_CAP } from "./kaku-san-rebalance.ts";
import { allocateBps, MIN_MAPPED_LEGS, type MappedLeg, type PersonIndexDefinition } from "./person-index-map.ts";
import { assertRaydiumOnlyToken, type RaydiumOracleKind, type RaydiumPoolBinding } from "./raydium-oracles.ts";

/** SDK `start_price` is divided by 10^6; "1000000" → $1 bootstrap. Unverified basis, same as Kaku San. */
export const INDEX_START_PRICE = "1000000";

const LAMPORTS = { create: 30_000_000, perToken: 12_000_000, weights: 5_000_000 } as const;

export type PersonVaultLeg = {
  ticker: string;
  mint: string;
  decimals: number;
  provider: MappedLeg["provider"];
  pool: string;
  kind: RaydiumOracleKind;
  tvlUsd: number;
  targetWeightBps: number;
  token: AddOrEditTokenInput;
};
export type PersonVaultInit = {
  indexId: string;
  personSlug: string;
  network: PersonIndexDefinition["network"];
  name: string;
  symbol: string;
  startPrice: string;
  hostEntryFeeBps: number;
  hostExitFeeBps: number;
  nativeTokenCap: number;
  mappedLegCount: number;
  legs: PersonVaultLeg[];
  poolExcludedLegs: { ticker: string; mint: string; reason: string }[];
  keeper: { pubkey: string | null; automationEnabled: false; targetsSource: "insiderindex_vault_definitions"; note: string };
  cost: CostPreview;
  estimatedOnly: true;
};

function oracleInput(leg: MappedLeg): OracleInput {
  return {
    oracle_type: (leg.pool.pool!.kind as RaydiumOracleKind) === "raydium_cpmm" ? "raydium_cpmm" : "raydium_clmm",
    account_lut_id: 0,
    account_lut_index: 0,
    account: leg.pool.pool!.pool,
    weight_bps: 10_000,
    is_required: true,
    conf_thresh_bps: 9999,
    volatility_thresh_bps: 9999,
    max_slippage_bps: 9999,
    min_liquidity: 0,
    staleness_thresh: 3600,
    staleness_conf_rate_bps: 0,
    token_decimals: leg.decimals,
    twap_seconds_ago: 30,
    twap_secondary_seconds_ago: 120,
    quote_token: "usdc",
  };
}

/** Documented estimate only — real bond/bounty need the live global config; never a quote. */
export function estimateVaultCost(legCount: number): CostPreview {
  const networkBudget = LAMPORTS.create + LAMPORTS.perToken * legCount + LAMPORTS.weights;
  return {
    hostEntryFeeBps: HOST_ENTRY_FEE_BPS,
    hostExitFeeBps: HOST_EXIT_FEE_BPS,
    globalConfigHash: "unverified-offline",
    otherNativeFees: [{ name: "host-management/performance", value: "0", kind: "flat" }],
    networkBudgetLamports: String(networkBudget),
    bountyMaxLockedRaw: "0",
    refundableBondRaw: "0",
    estimatedOnly: true,
  };
}

/**
 * Build the vault-init input. Throws when the mapped book exceeds the native leg cap (never
 * truncates), when the book is not an annual-weighted book, or when fewer than two mapped legs
 * carry observed Raydium pool evidence. Pool-excluded legs are recorded, not silently dropped.
 */
export function buildPersonVaultInit(definition: PersonIndexDefinition): PersonVaultInit {
  if (definition.weightBasis !== "annual-holding-value-midpoint") {
    throw new Error(`NOT_WEIGHTABLE: ${definition.indexId} book is ${definition.weightBasis}`);
  }
  // The request is the mapped book: asking for more legs than the vault can hold must throw.
  assertNativeTokenCap(definition.legs.length, "mapped legs");

  const ready = definition.legs.filter((l) => l.vaultReady && l.pool.pool);
  const poolExcludedLegs = definition.legs
    .filter((l) => !l.vaultReady)
    .map((l) => ({ ticker: l.ticker, mint: l.mint, reason: l.pool.reason ?? "no-observed-pool" }));
  if (ready.length < MIN_MAPPED_LEGS) {
    throw new Error(`INSUFFICIENT_POOL_READY_LEGS: ${definition.indexId} has ${ready.length} leg(s) with observed Raydium pools`);
  }
  assertNativeTokenCap(ready.length, "vault legs");

  const weights = allocateBps(ready.map((l) => l.valueBasis));
  const bindings: RaydiumPoolBinding[] = ready.map((l) => ({
    mint: l.mint,
    pool: l.pool.pool!.pool,
    kind: (l.pool.pool!.kind as RaydiumOracleKind) === "raydium_cpmm" ? "raydium_cpmm" : "raydium_clmm",
  }));
  const legs: PersonVaultLeg[] = ready.map((l, i) => {
    const token: AddOrEditTokenInput = {
      token_mint: address(l.mint),
      active: true,
      min_oracles_thresh: 1,
      min_conf_bps: 50,
      conf_thresh_bps: 200,
      conf_multiplier: 1,
      oracles: [oracleInput(l)],
    };
    // Reuse the Raydium-only guard against this leg's own documented pool binding: rejects Pyth,
    // a pool mismatch, or a lookalike account. Never invents a pool.
    assertRaydiumOnlyToken(token, [bindings[i]]);
    return {
      ticker: l.ticker,
      mint: l.mint,
      decimals: l.decimals,
      provider: l.provider,
      pool: l.pool.pool!.pool,
      kind: bindings[i].kind,
      tvlUsd: l.pool.pool!.tvlUsd,
      targetWeightBps: weights[i],
      token,
    };
  });
  weightsValid(legs.map((l) => ({ mint: l.mint, targetWeightBps: l.targetWeightBps })));

  return {
    indexId: definition.indexId,
    personSlug: definition.slug,
    network: definition.network,
    name: definition.indexName,
    symbol: definition.symbol,
    startPrice: INDEX_START_PRICE,
    hostEntryFeeBps: HOST_ENTRY_FEE_BPS,
    hostExitFeeBps: HOST_EXIT_FEE_BPS,
    nativeTokenCap: KAKU_SAN_NATIVE_TOKEN_CAP,
    mappedLegCount: definition.legs.length,
    legs,
    poolExcludedLegs,
    keeper: {
      pubkey: null,
      automationEnabled: false,
      targetsSource: "insiderindex_vault_definitions",
      note: "Keeper hot wallet unprovisioned on this machine; targets/eligibility are read from the DB record, eligibility math stays in kaku-san-rebalance.",
    },
    cost: estimateVaultCost(ready.length),
    estimatedOnly: true,
  };
}
