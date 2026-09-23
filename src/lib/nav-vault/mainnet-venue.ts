/**
 * Mainnet mark + swap adapters for the NAV vault keeper. Marks follow the repo price rule:
 * Raydium persisted-pool quote first (`buildCycleRoute`, direct CLMM), Jupiter `/swap/v2/build`
 * only if the leg has no usable pool; never Pyth/Hermes. Quotes are built, never sent.
 * Mainnet use requires the operator to deploy `programs/bin/nav_vault.so` (docs/nav-vault.md).
 */
import type { Connection } from "@solana/web3.js";
import { buildCycleRoute } from "../index-vaults/cycle-routes.ts";
import { fetchJupiterBuild } from "../index-vaults/jupiter-build.ts";
import { MAINNET_USDC } from "../index-vaults/native-defaults.ts";
import type { PersistedVaultLeg } from "../index-vaults/vault-definition-store.ts";
import { firstRoute, jupiterSwapBuilder, jupiterV1SwapBuilder, markFromQuote, type MarkSource, type SwapBuilder } from "./keeper.ts";

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
    if (input.env?.JUPITER_API_KEY?.trim()) {
      const built = await fetchJupiterBuild({ inputMint: MAINNET_USDC, outputMint: leg.mint.toBase58(), amountRaw: MARK_PROBE_USDC_RAW.toString(), taker: input.quoteOwner, env: input.env });
      if (built) return { price: markFromQuote(MARK_PROBE_USDC_RAW, BigInt(built.outAmount), leg.decimals), venue: "jupiter" };
    }
    const url = new URL("https://lite-api.jup.ag/swap/v1/quote");
    url.searchParams.set("inputMint", MAINNET_USDC); url.searchParams.set("outputMint", leg.mint.toBase58());
    url.searchParams.set("amount", MARK_PROBE_USDC_RAW.toString()); url.searchParams.set("slippageBps", "50");
    const response = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
    const quote = response.ok ? await response.json() as { outAmount?: string; inAmount?: string } : null;
    if (!quote?.outAmount || quote.inAmount !== MARK_PROBE_USDC_RAW.toString()) throw new Error(`No Raydium or Jupiter mark for ${leg.mint.toBase58()}.`);
    return { price: markFromQuote(MARK_PROBE_USDC_RAW, BigInt(quote.outAmount), leg.decimals), venue: "jupiter-v1" };
  };
  // v2 build first when a key is configured; v1 swap-instructions (verified with a PDA taker) otherwise / as fallback.
  const v1 = jupiterV1SwapBuilder({ connection: input.connection, apiKey: input.env?.JUPITER_API_KEY?.trim() || undefined });
  return { marks, swaps: input.env?.JUPITER_API_KEY?.trim() ? firstRoute(jupiterSwapBuilder({ env: input.env }), v1) : v1 };
}
