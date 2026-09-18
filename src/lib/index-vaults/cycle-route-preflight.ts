import type { Connection } from "@solana/web3.js";
import { rawAmount } from "./amounts.ts";
import { buildCycleRoute, type PoolMetadata } from "./cycle-routes.ts";
import { MAINNET_USDC } from "./native-defaults.ts";
import type { CyclePolicy } from "./cycle-policy-parse.ts";
import type { PersistedVaultDefinition } from "./vault-definition-store.ts";
/** Shared read-only, both-direction prerequisite. Independently callable by the wallet; not
 * a guarantee of market liquidity/prices/issuer permission at a later redemption. */
export async function preflightCycleConnectionRoutes(connection: Connection, record: PersistedVaultDefinition, policy: CyclePolicy, metadata?: PoolMetadata) {
  let minimum = 0n;
  const routes = [];
  for (const leg of record.vaultLegs) {
    const input = rawAmount(policy.limits.depositUsdcRaw) * BigInt(leg.targetWeightBps) / 10000n;
    if (input === 0n) throw new Error("CYCLE_AMOUNT_CANNOT_REPRESENT_EVERY_LEG");
    const buy = await buildCycleRoute({ connection, leg, owner: policy.keeper, inputMint: MAINNET_USDC, outputMint: leg.mint, amountInRaw: input.toString(), slippageBps: policy.limits.swapSlippageBps, maxAgeMs: policy.limits.quoteMaxAgeMs, metadata });
    const exit = await buildCycleRoute({ connection, leg, owner: policy.owner, inputMint: leg.mint, outputMint: MAINNET_USDC, amountInRaw: buy.minOutRaw, slippageBps: policy.limits.swapSlippageBps, maxAgeMs: policy.limits.quoteMaxAgeMs, metadata });
    minimum += rawAmount(exit.minOutRaw); routes.push(buy, exit);
  }
  if (routes.some(r => r.expiresAt <= Date.now()) || minimum < rawAmount(policy.limits.minExitUsdcRaw)) throw new Error("CYCLE_EXIT_PREREQUISITE_NOT_MET");
  return { quotedExitMinimumUsdcRaw: minimum.toString(), expiresAt: Math.min(...routes.map(r => r.expiresAt)) };
}
