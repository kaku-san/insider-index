import type { AddOrEditTokenInput } from "@symmetry-hq/sdk";
import { RaydiumClmmPoolState } from "@symmetry-hq/sdk/dist/states/oracles/raydiumClmmOracle.js";
import { fractionToDecimal } from "@symmetry-hq/sdk/dist/layouts/fraction.js";
import { Quote, Side } from "@symmetry-hq/sdk/dist/layouts/oracle.js";
import { PublicKey, type Connection } from "@solana/web3.js";
import { address } from "./amounts.ts";
import { assertRaydiumOnlyToken, assertRaydiumOnlyVault, WSOL_MINT, type RaydiumPoolBinding, type VaultOracleView } from "./raydium-oracles.ts";

export const MAINNET_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
/** Read-only mainnet capture at slot 447813178; see docs/composition-resume.md.
 * These are native support/cash slots, NEVER catalog investment legs. */
export const NATIVE_DEFAULT_POOL = "3ucNos4NbumPLZNWztqGHNFFgkHeRMBQAVemeeomsUxv";
const CLMM_PROGRAM = "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK";
export const NATIVE_DEFAULT_BINDINGS: readonly RaydiumPoolBinding[] = Object.freeze(
  [WSOL_MINT, MAINNET_USDC].map(mint => ({ mint, pool: NATIVE_DEFAULT_POOL, kind: "raydium_clmm" as const })),
);

/** Verify the observed pool's owner, mint pair and decimals afresh; never infer a pool by ticker. */
export async function assertNativeDefaultPool(connection: Connection): Promise<void> {
  const account = await connection.getAccountInfo(new PublicKey(NATIVE_DEFAULT_POOL), "confirmed");
  if (!account || account.owner.toBase58() !== CLMM_PROGRAM) throw new Error("NATIVE_DEFAULT_POOL: missing/wrong-owner Raydium pool");
  const pool = RaydiumClmmPoolState.decode(account.data, 8);
  if (pool.tokenMint0.toBase58() !== WSOL_MINT || pool.tokenMint1.toBase58() !== MAINNET_USDC || pool.mintDecimals0 !== 9 || pool.mintDecimals1 !== 6) {
    throw new Error("NATIVE_DEFAULT_POOL: mint pair/decimals mismatch");
  }
}

/** Native rejects empty oracle weights even for inactive tokens (6020). WSOL is force-active
 * in deployed native intent creation. Retain it explicitly; final target MUST still be zero. */
export function nativeDefaultInput(mint: string): AddOrEditTokenInput {
  const key = address(mint);
  if (!NATIVE_DEFAULT_BINDINGS.some(b => b.mint === key)) throw new Error("Only the creation-time WSOL/USDC slots may be configured");
  const sol = key === WSOL_MINT;
  const token: AddOrEditTokenInput = {
    token_mint: key, active: sol,
    min_oracles_thresh: 1, min_conf_bps: 50, conf_thresh_bps: 200, conf_multiplier: 1,
    oracles: [{
      oracle_type: "raydium_clmm", account_lut_id: 0, account_lut_index: 0,
      account: NATIVE_DEFAULT_POOL, weight_bps: 10_000, is_required: true,
      conf_thresh_bps: 9999, volatility_thresh_bps: 9999, max_slippage_bps: 9999,
      min_liquidity: 0, staleness_thresh: 3600, staleness_conf_rate_bps: 0,
      token_decimals: sol ? 9 : 6, twap_seconds_ago: 30, twap_secondary_seconds_ago: 120,
      quote_token: sol ? "usdc" : "wsol",
    }],
  };
  assertRaydiumOnlyToken(token, NATIVE_DEFAULT_BINDINGS);
  return token;
}

export function active(asset: { active: number | boolean }): boolean { return asset.active === 1 || asset.active === true; }

/** Token-level readback, including inactive cash. A zero target never exempts a balance from pricing. */
export function assertInstalledToken(vault: VaultOracleView, input: AddOrEditTokenInput): void {
  const rows = vault.composition.slice(0, vault.numTokens).filter(a => a.mint.toBase58() === input.token_mint);
  if (rows.length !== 1 || ![0, 1, false, true].includes(rows[0].active) || active(rows[0]) !== input.active) throw new Error(`COMPOSITION_TOKEN: missing/duplicate/wrong active flag ${input.token_mint}`);
  const row = rows[0], agg = row.oracleAggregator;
  if (input.oracles.length !== 1) throw new Error("COMPOSITION_ORACLE: one explicitly bound Raydium oracle required");
  const expected = input.oracles[0];
  assertRaydiumOnlyVault({ ...vault, composition: [row], numTokens: 1 }, [{ mint: input.token_mint, pool: expected.account, kind: expected.oracle_type as RaydiumPoolBinding["kind"] }]);
  const settings = agg.oracles[0].oracleSettings;
  if (agg.numOracles !== 1 || agg.minOraclesThresh !== input.min_oracles_thresh || agg.minConfBps !== input.min_conf_bps || agg.confThreshBps !== input.conf_thresh_bps ||
      !fractionToDecimal(agg.confMultiplier).eq(input.conf_multiplier) ||
      settings.weight !== expected.weight_bps || settings.isRequired !== Number(expected.is_required) || settings.tokenDecimals !== expected.token_decimals ||
      settings.confThreshBps !== expected.conf_thresh_bps || settings.volatilityThreshBps !== expected.volatility_thresh_bps || settings.maxSlippageBps !== expected.max_slippage_bps ||
      settings.minLiquidity.toString() !== String(expected.min_liquidity) || settings.stalenessThresh.toString() !== String(expected.staleness_thresh) ||
      settings.stalenessConfRateBps !== expected.staleness_conf_rate_bps || settings.twapSecondsAgo.toString() !== String(expected.twap_seconds_ago) || settings.twapSecondarySecondsAgo.toString() !== String(expected.twap_secondary_seconds_ago) ||
      settings.quote !== (expected.quote_token === "usdc" ? Quote.Usdc : expected.quote_token === "wsol" ? Quote.Wsol : Quote.Usd) ||
      (input.token_mint === WSOL_MINT && settings.side !== Side.Base) || (input.token_mint === MAINNET_USDC && settings.side !== Side.Quote)) {
    throw new Error(`COMPOSITION_ORACLE: aggregator mismatch ${input.token_mint}`);
  }
}

export function installedToken(vault: VaultOracleView, input: AddOrEditTokenInput): boolean {
  try { assertInstalledToken(vault, input); return true; } catch { return false; }
}

/** Native eligibility exempts the bounty mint from direct drift. Do not assume this sweeps
 * zero-target WSOL backing. Until full-cycle accounting/USDC conversion is proved, stop the
 * keeper on a nonzero composition balance (separate from settings.bountyBalance). */
export const NATIVE_SUPPORT_BALANCE_REASON = "Zero-target WSOL has a nonzero backing balance; reconcile bounty/backing and prove USDC conversion before keeper execution";
export function hasUnreconciledSupportBalance(vault: Pick<VaultOracleView, "composition" | "numTokens">): boolean {
  return vault.composition.slice(0, vault.numTokens).some(a => a.mint.toBase58() === WSOL_MINT && a.weight === 0 && a.amount.toString() !== "0");
}

/** Keeper paths may read older baskets, but no present support slot may acquire an investment
 * weight or an oracle/active-flag exception. Missing slots are rejected by install verification. */
export function assertNativeSupportTargets(vault: VaultOracleView): void {
  for (const row of vault.composition.slice(0, vault.numTokens)) {
    const mint = row.mint.toBase58();
    if (!NATIVE_DEFAULT_BINDINGS.some(b => b.mint === mint)) continue;
    assertInstalledToken(vault, nativeDefaultInput(mint));
    if (row.weight !== 0) throw new Error(`COMPOSITION_SUPPORT_WEIGHT: ${mint} must have zero target`);
  }
}

export function configuredDefaults(vault: VaultOracleView): string[] {
  return NATIVE_DEFAULT_BINDINGS.filter(b => installedToken(vault, nativeDefaultInput(b.mint))).map(b => b.mint);
}

/** EXACT investment basket plus narrowly bounded native defaults. No arbitrary extra mint,
 * positive SOL allocation, active USDC, missing oracle or Pyth exemption. This verifies only
 * configuration, NOT backing/fees/bounty accounting or deposit/USDC-exit readiness. */
export function assertInstalledComposition(vault: VaultOracleView, legs: readonly { mint: string; targetWeightBps: number; token: AddOrEditTokenInput }[]): void {
  const allocated = vault.composition.slice(0, vault.numTokens);
  const expected = [...legs.map(l => l.mint), WSOL_MINT, MAINNET_USDC];
  if (new Set(expected).size !== expected.length || allocated.length !== expected.length || allocated.some(a => !expected.includes(a.mint.toBase58()))) {
    throw new Error("COMPOSITION_MINTS: unexpected/missing allocated mint");
  }
  for (const leg of legs) {
    assertInstalledToken(vault, leg.token);
    if (allocated.find(a => a.mint.toBase58() === leg.mint)!.weight !== leg.targetWeightBps) throw new Error(`COMPOSITION_WEIGHT: ${leg.mint}`);
  }
  for (const binding of NATIVE_DEFAULT_BINDINGS) {
    assertInstalledToken(vault, nativeDefaultInput(binding.mint));
    if (allocated.find(a => a.mint.toBase58() === binding.mint)!.weight !== 0) throw new Error(`COMPOSITION_SUPPORT_WEIGHT: ${binding.mint} must have zero target`);
  }
}
