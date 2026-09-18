import type { Connection } from "@solana/web3.js";
import { rawAmount, weightsValid } from "./amounts.ts";
import { buildCycleRoute, type PoolMetadata } from "./cycle-routes.ts";
import { MAINNET_USDC } from "./native-defaults.ts";
import type { CyclePolicy } from "./cycle-policy-parse.ts";
import type { PersistedVaultDefinition } from "./vault-definition-store.ts";

export interface NativeRepaymentBound { inMint: string; outMint: string; inAmount: number; outAmount: number; }
/** Shared read-only, both-direction prerequisite. Independently callable by the wallet; not
 * a guarantee of market liquidity/prices/issuer permission at a later redemption. */
export async function preflightCycleConnectionRoutes(connection: Connection, record: PersistedVaultDefinition, policy: CyclePolicy, metadata: PoolMetadata | undefined, repayments?: readonly NativeRepaymentBound[]) {
  // Estimates use the installed literal /10000 weights. Never renormalize a
  // malformed definition into a different economic allocation.
  weightsValid(record.vaultLegs);
  let minimum = 0n;
  const routes = [];
  const observed = new Map<string, NativeRepaymentBound>();
  for (const repayment of repayments ?? []) {
    if (repayment.outMint !== MAINNET_USDC || !Number.isSafeInteger(repayment.inAmount) || !Number.isSafeInteger(repayment.outAmount) || repayment.inAmount <= 0 || repayment.outAmount <= 0 || observed.has(repayment.inMint)) throw new Error("CYCLE_NATIVE_REPAYMENT_BOUNDS_INVALID");
    observed.set(repayment.inMint, repayment);
  }
  for (const leg of record.vaultLegs) {
    const repayment = observed.get(leg.mint);
    const amountInRaw = repayment ? String(repayment.outAmount) : (rawAmount(policy.limits.depositUsdcRaw) * BigInt(leg.targetWeightBps) / 10000n).toString();
    if (amountInRaw === "0") throw new Error("CYCLE_NATIVE_REPAYMENT_BOUNDS_UNOBSERVED");
    const buy = await buildCycleRoute({ connection, leg, owner: policy.keeper, inputMint: MAINNET_USDC, outputMint: leg.mint, amountInRaw, minimumOutRaw: repayment ? String(repayment.inAmount) : undefined, slippageBps: policy.limits.swapSlippageBps, maxAgeMs: policy.limits.quoteMaxAgeMs, metadata });
    const exit = await buildCycleRoute({ connection, leg, owner: policy.owner, inputMint: leg.mint, outputMint: MAINNET_USDC, amountInRaw: buy.minOutRaw, slippageBps: policy.limits.swapSlippageBps, maxAgeMs: policy.limits.quoteMaxAgeMs, metadata });
    minimum += rawAmount(exit.minOutRaw); routes.push(buy, exit);
  }
  if ((repayments?.length && observed.size !== record.vaultLegs.length) || routes.some(r => r.expiresAt <= Date.now()) || minimum < rawAmount(policy.limits.minExitUsdcRaw)) throw new Error("CYCLE_EXIT_PREREQUISITE_NOT_MET");
  return { quotedExitMinimumUsdcRaw: minimum.toString(), expiresAt: Math.min(...routes.map(r => r.expiresAt)) };
}
