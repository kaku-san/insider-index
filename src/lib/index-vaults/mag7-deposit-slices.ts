import type { Connection } from "@solana/web3.js";
import { rawAmount, weightsValid } from "./amounts.ts";
import { buildCycleRoute, type PoolMetadata } from "./cycle-routes.ts";
import { MAINNET_USDC } from "./native-defaults.ts";
import type { PersistedVaultDefinition } from "./vault-definition-store.ts";

export const MAG7_INDEX_ID = "idx-theme-mag7-caucus";
export const MAG7_UNROUTABLE_AMOUNT = "This amount cannot buy Mag7 right now.";

/** Weighted USDC slice at this contribution. Never a $1 quote-only floor. */
export function mag7WeightedSliceRaw(amountRaw: string, targetWeightBps: number): string {
  return (rawAmount(amountRaw) * BigInt(targetWeightBps) / 10000n).toString();
}

/**
 * Quote every Mag7 investment leg at this size on Raydium before buyVaultTx/lock.
 * Any unroutable slice refuses the whole deposit so names are never skipped into the vault.
 */
export async function assertWeightedSlicesRoutable(input: {
  connection: Connection;
  definition: PersistedVaultDefinition;
  amountRaw: string;
  owner?: string;
  metadata?: PoolMetadata;
  routeBuilder?: typeof buildCycleRoute;
}): Promise<void> {
  if (input.definition.indexId !== MAG7_INDEX_ID) return;
  if (input.definition.vaultLegs.length !== 7 || new Set(input.definition.vaultLegs.map(leg => leg.mint)).size !== 7) {
    throw new Error("Mag7 requires seven distinct investment legs before accepting a deposit.");
  }
  weightsValid(input.definition.vaultLegs);
  const routeBuilder = input.routeBuilder ?? buildCycleRoute;
  const quoted = new Set<string>();
  for (const leg of input.definition.vaultLegs) {
    const amountInRaw = mag7WeightedSliceRaw(input.amountRaw, leg.targetWeightBps);
    if (amountInRaw === "0") throw new Error(MAG7_UNROUTABLE_AMOUNT);
    try {
      await routeBuilder({
        connection: input.connection,
        leg,
        owner: input.owner ?? "11111111111111111111111111111111",
        inputMint: MAINNET_USDC,
        outputMint: leg.mint,
        amountInRaw,
        slippageBps: 50,
        maxAgeMs: 60_000,
        metadata: input.metadata,
      });
    } catch {
      throw new Error(MAG7_UNROUTABLE_AMOUNT);
    }
    quoted.add(leg.mint);
  }
  if (quoted.size !== 7) throw new Error(MAG7_UNROUTABLE_AMOUNT);
}
