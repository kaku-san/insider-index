import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import type { AddOrEditTokenInput, OracleInput, Vault } from "@symmetry-hq/sdk";
import { OracleType } from "@symmetry-hq/sdk/dist/layouts/oracle.js";
import { updateTokenPricesIx } from "@symmetry-hq/sdk/dist/instructions/automation/priceUpdate.js";
import { getRebalanceIntentPda } from "@symmetry-hq/sdk/dist/instructions/pda.js";
import { UPDATE_TOKEN_PRICES_MAX_ACCOUNTS } from "@symmetry-hq/sdk/dist/constants.js";
import { address } from "./amounts.ts";

/**
 * Symmetry pricing policy: Raydium pools only. No Pyth oracle accounts, no Hermes client, no
 * `HERMES_*`/`PYTH_*` environment. The pinned SDK's `updateTokenPricesTx` unconditionally opens a
 * Hermes client (even with zero Pyth oracles), so vault settlement builds the native
 * `update_token_prices` instruction here from the vault's own Raydium oracle account list.
 */
export const RAYDIUM_ORACLE_KINDS = Object.freeze({ raydium_clmm: OracleType.RaydiumClmm, raydium_cpmm: OracleType.RaydiumCpmm });
export type RaydiumOracleKind = keyof typeof RAYDIUM_ORACLE_KINDS;
const RAYDIUM_TYPE_CODES = new Set<number>(Object.values(RAYDIUM_ORACLE_KINDS));

/** Config shape: mint → Raydium pool pubkey + kind. Never a Pyth price-account id. */
export interface RaydiumPoolBinding { mint: string; pool: string; kind: RaydiumOracleKind }

export const WSOL_MINT = "So11111111111111111111111111111111111111112";
/** Existing devnet test basket. Both legs read the same WSOL/SDK-USDC CPMM pool (WSOL = base, USDC = quote). */
export const DEVNET_RAYDIUM_POOLS: readonly RaydiumPoolBinding[] = Object.freeze([
  { mint: WSOL_MINT, pool: "5Eu2G2USTy1pqphmQzQ2SBXWrBq5sdhgEh7hso9R2xix", kind: "raydium_cpmm" },
  { mint: "USDCoctVLVnvTXBEuP9s8hntucdJokbo17RwHuNXemT", pool: "5Eu2G2USTy1pqphmQzQ2SBXWrBq5sdhgEh7hso9R2xix", kind: "raydium_cpmm" },
]);

export function raydiumPoolFor(mint: string, bindings: readonly RaydiumPoolBinding[] = DEVNET_RAYDIUM_POOLS): RaydiumPoolBinding {
  const binding = bindings.find(b => b.mint === address(mint));
  // Policy: never invent a pool. A mint without a documented Raydium pool is not listable.
  if (!binding) throw new Error(`RAYDIUM_POOL_REQUIRED: no Raydium pool is documented for mint ${mint}; block listing`);
  return binding;
}

/** Any `HERMES_*` / `PYTH_*` variable means the settlement path could reach Pyth. Fail closed. */
export function assertNoPythEnvironment(env: NodeJS.ProcessEnv = process.env): void {
  const offenders = Object.keys(env).filter(key => /^(HERMES_|PYTH_)/i.test(key)).sort();
  if (offenders.length) throw new Error(`PYTH_ENV_FORBIDDEN: unset ${offenders.join(", ")}`);
}

export function assertRaydiumOracleInput(oracle: OracleInput): void {
  if (!(oracle.oracle_type in RAYDIUM_ORACLE_KINDS)) throw new Error(`ORACLE_TYPE_FORBIDDEN: ${String(oracle.oracle_type)} (Raydium CLMM/CPMM only)`);
  address(oracle.account);
}
/** Token add/edit: at least one oracle, every oracle a Raydium pool. */
export function assertRaydiumOnlyToken(token: AddOrEditTokenInput): void {
  if (!Array.isArray(token.oracles) || token.oracles.length === 0) throw new Error("ORACLE_REQUIRED: a token needs at least one Raydium oracle");
  for (const oracle of token.oracles) assertRaydiumOracleInput(oracle);
}

export type VaultOracleView = Pick<Vault, "composition" | "numTokens">;
export interface VaultOracleSummary { mint: string; oracleTypes: number[] }
/** Installed native oracles must all be Raydium; otherwise settlement refuses to price. */
export function assertRaydiumOnlyVault(vault: VaultOracleView): VaultOracleSummary[] {
  const summary: VaultOracleSummary[] = [];
  for (const asset of vault.composition.slice(0, vault.numTokens)) {
    const aggregator = asset.oracleAggregator;
    const types = aggregator.oracles.slice(0, aggregator.numOracles).map(o => o.oracleSettings.oracleType);
    if (types.length === 0) throw new Error(`ORACLE_REQUIRED: ${asset.mint.toBase58()} has no installed oracle`);
    const forbidden = types.filter(type => !RAYDIUM_TYPE_CODES.has(type));
    if (forbidden.length) throw new Error(`ORACLE_TYPE_FORBIDDEN: ${asset.mint.toBase58()} installs oracle type ${forbidden.join(",")}; Raydium CLMM/CPMM only`);
    summary.push({ mint: asset.mint.toBase58(), oracleTypes: types });
  }
  return summary;
}

type PriceUpdateVault = VaultOracleView & Pick<Vault, "ownAddress" | "mint" | "lutPubkeys" | "lookupTables" | "settings">;
export interface RaydiumPriceUpdatePlan {
  instructions: TransactionInstruction[];
  lookupTables: PublicKey[];
  /** Oracle accounts loaded per instruction, in wire order (all Raydium pool/vault/observation accounts). */
  oracleAccounts: string[][];
  tokenIndices: number[][];
  oracles: VaultOracleSummary[];
}
/**
 * Native `update_token_prices` for every allocated token, grouped by the program's account limit,
 * mirroring the SDK's token-index grouping but with no Pyth feed lookup and no Hermes/VAA batches.
 */
export function planRaydiumPriceUpdate(input: { vault: PriceUpdateVault; keeper: string; rebalanceIntent: string }): RaydiumPriceUpdatePlan {
  const { vault } = input;
  const oracles = assertRaydiumOnlyVault(vault);
  const keeper = new PublicKey(address(input.keeper));
  const rebalanceIntent = new PublicKey(address(input.rebalanceIntent));
  const instructions: TransactionInstruction[] = [];
  const oracleAccounts: string[][] = [];
  const tokenIndices: number[][] = [];
  for (let start = 0; start < vault.numTokens; start++) {
    const keys: PublicKey[] = [];
    const indices: number[] = [];
    for (let end = start; end < vault.numTokens; end++) {
      const aggregator = vault.composition[end].oracleAggregator;
      const needed = aggregator.oracles.slice(0, aggregator.numOracles).reduce((sum, o) => sum + o.oracleSettings.numRequiredAccounts, 0);
      if (keys.length + needed > UPDATE_TOKEN_PRICES_MAX_ACCOUNTS || indices.length === 20) break;
      start = end;
      indices.push(end);
      for (const oracle of aggregator.oracles.slice(0, aggregator.numOracles)) {
        for (let j = 0; j < oracle.oracleSettings.numRequiredAccounts; j++) {
          const table = vault.lutPubkeys?.[oracle.accountsToLoadLutIds[j]];
          const key = table?.state.addresses[oracle.accountsToLoadLutIndices[j]];
          if (!key) throw new Error("ORACLE_ACCOUNT_MISSING: vault lookup table lacks a Raydium oracle account");
          keys.push(key);
        }
      }
    }
    if (indices.length === 0) throw new Error("ORACLE_ACCOUNT_LIMIT: one token exceeds the native price-update account limit");
    const fees = vault.settings.fees;
    const performanceFees = fees.hostPerformanceFeeBps + fees.creatorPerformanceFeeBps + fees.managersPerformanceFeeBps;
    instructions.push(updateTokenPricesIx({
      keeper, vault: vault.ownAddress, rebalanceIntent,
      lookupTable0: vault.lookupTables.active[0], lookupTable1: vault.lookupTables.active[1],
      tokenIndices: indices, additionalOracleAccounts: keys,
      vaultRebalanceIntent: vault.settings.activeRebalance.isZero() ? undefined : getRebalanceIntentPda(vault.ownAddress, vault.ownAddress),
      vaultMint: performanceFees > 0 ? vault.mint : undefined,
    }));
    oracleAccounts.push(keys.map(k => k.toBase58()));
    tokenIndices.push([...indices]);
  }
  return { instructions, lookupTables: [vault.lookupTables.active[0], vault.lookupTables.active[1]], oracleAccounts, tokenIndices, oracles };
}

/** Raydium CPMM observation ring: latest observation timestamp (the program's staleness input). */
export function raydiumCpmmObservationTimestamp(data: Uint8Array): number {
  const view = Buffer.from(data);
  if (view.length < 8 + 1 + 2 + 32 + 40) throw new Error("Malformed Raydium CPMM observation account");
  const index = view.readUInt16LE(9);
  if (index >= 100) throw new Error("Malformed Raydium CPMM observation index");
  const offset = 8 + 1 + 2 + 32 + index * 40;
  const timestamp = view.readBigUInt64LE(offset);
  if (timestamp > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Malformed Raydium CPMM observation timestamp");
  return Number(timestamp);
}
