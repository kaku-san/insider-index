/**
 * Mainnet mark + swap adapters for the NAV vault keeper. Marks follow the repo price rule:
 * Raydium persisted-pool quote first (`buildCycleRoute`, direct CLMM), Jupiter `/swap/v2/build`
 * only if the leg has no usable pool; never Pyth/Hermes. Quotes are built, never sent.
 * NOT deployed: this branch proves the program on devnet only.
 */
import type { Connection } from "@solana/web3.js";
import { buildCycleRoute } from "../index-vaults/cycle-routes.ts";
import { fetchJupiterBuild } from "../index-vaults/jupiter-build.ts";
import { MAINNET_USDC } from "../index-vaults/native-defaults.ts";
import type { PersistedVaultLeg } from "../index-vaults/vault-definition-store.ts";
import { jupiterSwapBuilder, markFromQuote, type MarkSource, type SwapBuilder } from "./keeper.ts";

export const MARK_PROBE_USDC_RAW = 100_000_000n; // $100 probe: an executable ask, not a mid.

export function mainnetVenue(input: { connection: Connection; legs: readonly PersistedVaultLeg[]; quoteOwner: string; env?: { JUPITER_API_KEY?: string } }): { marks: MarkSource; swaps: SwapBuilder } {
  const marks: MarkSource = async leg => {
    const persisted = input.legs.find(item => item.mint === leg.mint.toBase58());
    if (persisted?.pool && persisted.kind === "raydium_clmm") {
      try {
        const route = await buildCycleRoute({
          connection: input.connection, leg: persisted, owner: input.quoteOwner, inputMint: MAINNET_USDC, outputMint: persisted.mint,
          amountInRaw: MARK_PROBE_USDC_RAW.toString(), slippageBps: 50, maxAgeMs: 60_000,
        });
        return { price: markFromQuote(MARK_PROBE_USDC_RAW, BigInt(route.expectedOutRaw), leg.decimals), venue: "raydium" };
      } catch { /* no usable pool quote: Jupiter below */ }
    }
    const built = await fetchJupiterBuild({ inputMint: MAINNET_USDC, outputMint: leg.mint.toBase58(), amountRaw: MARK_PROBE_USDC_RAW.toString(), taker: input.quoteOwner, env: input.env });
    if (!built) throw new Error(`No Raydium or Jupiter mark for ${leg.mint.toBase58()}.`);
    return { price: markFromQuote(MARK_PROBE_USDC_RAW, BigInt(built.outAmount), leg.decimals), venue: "jupiter" };
  };
  return { marks, swaps: jupiterSwapBuilder({ env: input.env }) };
}
