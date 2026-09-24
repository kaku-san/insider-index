/**
 * Mainnet mark + swap adapters for the NAV vault keeper. Marks follow the repo price rule:
 * Raydium persisted-pool quote first (`buildCycleRoute`, direct CLMM), Jupiter `/swap/v2/build`
 * only if the leg has no usable pool; never Pyth/Hermes. Quotes are built, never sent. A mark is
 * the mid of a $100 ask and the matching bid (sell-side) quote.
 * The deployed mainnet program and the newer committed binary are distinguished in docs/nav-vault.md.
 */
import { PublicKey, TransactionInstruction, type Connection } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { buildCycleRoute } from "../index-vaults/cycle-routes.ts";
import { fetchJupiterBuild } from "../index-vaults/jupiter-build.ts";
import { MAINNET_USDC } from "./constants.ts";
import type { PersistedVaultLeg } from "../index-vaults/vault-definition-store.ts";
import { firstRoute, jupiterV1SwapBuilder, markFromQuote, type MarkSource, type SwapBuilder } from "./keeper.ts";
import { legAccount, legIndex } from "./program.ts";

export const MARK_PROBE_USDC_RAW = 100_000_000n; // $100 probe on each side of the book.

/** Bid/ask ratio per mint (parts per million), measured by a sell-side quote; refreshed every 5 minutes. */
const BID_REFRESH_MS = 5 * 60_000;
const bidSpreads = new Map<string, { bidOverAskPpm: bigint | null; at: number }>();

/** Mid of an executable ask (USDC → leg) and bid (the same leg amount → USDC); the ask alone when no bid quotes. */
export function midMark(askPrice: bigint, bidPrice: bigint | null): bigint {
  if (!bidPrice || bidPrice <= 0n || bidPrice > askPrice) return askPrice;
  return (askPrice + bidPrice) / 2n;
}

export function mainnetVenue(input: { connection: Connection; legs: readonly PersistedVaultLeg[]; quoteOwner: string; env?: { JUPITER_API_KEY?: string } }): { marks: MarkSource; swaps: SwapBuilder } {
  /** Executable output for `amountRaw` of `inputMint`: persisted Raydium pool first, then Jupiter. */
  const quoteOut = async (persisted: PersistedVaultLeg | undefined, inputMint: string, outputMint: string, amountRaw: bigint): Promise<{ out: bigint; venue: string }> => {
    if (persisted?.pool && persisted.kind === "raydium_clmm") {
      try {
        const route = await buildCycleRoute({
          connection: input.connection, leg: persisted, owner: input.quoteOwner, inputMint, outputMint,
          amountInRaw: amountRaw.toString(), slippageBps: 50, maxAgeMs: 60_000,
        });
        return { out: BigInt(route.expectedOutRaw), venue: "raydium" };
      } catch { /* no usable pool quote: Jupiter below */ }
    }
    if (input.env?.JUPITER_API_KEY?.trim()) {
      const built = await fetchJupiterBuild({ inputMint, outputMint, amountRaw: amountRaw.toString(), taker: input.quoteOwner, env: input.env });
      if (built) return { out: BigInt(built.outAmount), venue: "jupiter" };
    }
    const url = new URL("https://lite-api.jup.ag/swap/v1/quote");
    url.searchParams.set("inputMint", inputMint); url.searchParams.set("outputMint", outputMint);
    url.searchParams.set("amount", amountRaw.toString()); url.searchParams.set("slippageBps", "50");
    const response = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
    const quote = response.ok ? await response.json() as { outAmount?: string; inAmount?: string } : null;
    if (!quote?.outAmount || quote.inAmount !== amountRaw.toString()) throw new Error(`No Raydium or Jupiter quote for ${inputMint} → ${outputMint}.`);
    return { out: BigInt(quote.outAmount), venue: "jupiter-v1" };
  };
  // Marks are the mid of both sides, so NAV and the on-chain sell bound reflect what the vault can
  // realise, not the ask alone (an ask mark makes every sale look like a loss beyond max_slippage).
  // The bid side is re-quoted every BID_REFRESH_MS; between refreshes the last measured spread is
  // applied to the fresh ask, so a mark still costs one quote and the mark cadence holds.
  const marks: MarkSource = async leg => {
    const persisted = input.legs.find(item => item.mint === leg.mint.toBase58());
    const mint = leg.mint.toBase58();
    const ask = await quoteOut(persisted, MAINNET_USDC, mint, MARK_PROBE_USDC_RAW).catch(error => { throw new Error(`No Raydium or Jupiter mark for ${mint}. ${(error as Error).message}`); });
    const askPrice = markFromQuote(MARK_PROBE_USDC_RAW, ask.out, leg.decimals);
    let spread = bidSpreads.get(mint);
    if (!spread || Date.now() - spread.at > BID_REFRESH_MS) {
      const bid = await quoteOut(persisted, mint, MAINNET_USDC, ask.out).catch(() => null);
      const bidPrice = bid && bid.out > 0n ? (bid.out * 10n ** BigInt(leg.decimals)) / ask.out : null;
      spread = { bidOverAskPpm: bidPrice && bidPrice <= askPrice ? (bidPrice * 1_000_000n) / askPrice : null, at: Date.now() };
      bidSpreads.set(mint, spread);
    }
    const price = midMark(askPrice, spread.bidOverAskPpm === null ? null : (askPrice * spread.bidOverAskPpm) / 1_000_000n);
    return { price, venue: price === askPrice ? `${ask.venue}-ask` : `${ask.venue}-mid` };
  };
  // Jupiter FIRST (v1 /swap-instructions with shared accounts, CPI-safe DEXes: v2 `route_v2` fails
  // InvalidTokenAccount (6025) when invoked via CPI with the vault PDA as taker); a direct Raydium CLMM
  // swap on the persisted pool is the per-leg fallback only when Jupiter has no working route.
  const jupiter = jupiterV1SwapBuilder({ connection: input.connection, apiKey: input.env?.JUPITER_API_KEY?.trim() || undefined });
  const raydium = raydiumSwapBuilder({ connection: input.connection, legs: input.legs, quoteOwner: input.quoteOwner });
  return { marks, swaps: firstRoute(jupiter, raydium) };
}

/**
 * Direct Raydium CLMM SwapV2 on the persisted pool (fallback only). `buildCycleRoute` builds for an
 * on-curve wallet, so it is quoted for `quoteOwner` and then rebound: owner → vault authority PDA, the
 * owner's input/output ATAs → the vault's own token accounts. Pool/tick accounts are untouched.
 */
export function raydiumSwapBuilder(input: { connection: Connection; legs: readonly PersistedVaultLeg[]; quoteOwner: string }): SwapBuilder {
  return async swap => {
    const stock = swap.inMint.toBase58() === MAINNET_USDC ? swap.outMint : swap.inMint;
    const leg = input.legs.find(item => item.mint === stock.toBase58());
    if (!leg?.pool || leg.kind !== "raydium_clmm") return null;
    const route = await buildCycleRoute({
      connection: input.connection, leg, owner: input.quoteOwner, inputMint: swap.inMint.toBase58(), outputMint: swap.outMint.toBase58(),
      amountInRaw: swap.amountIn.toString(), slippageBps: 50, maxAgeMs: 60_000,
    });
    const owner = new PublicKey(input.quoteOwner);
    const rebind = new Map([
      [owner.toBase58(), swap.authority],
      [getAssociatedTokenAddressSync(swap.inMint, owner, false, swap.inTokenProgram).toBase58(), legAccount(swap.vault, legIndex(swap.vault, swap.inMint))],
      [getAssociatedTokenAddressSync(swap.outMint, owner, false, swap.outTokenProgram).toBase58(), legAccount(swap.vault, legIndex(swap.vault, swap.outMint))],
    ]);
    const ix = new TransactionInstruction({
      programId: route.instruction.programId, data: route.instruction.data,
      keys: route.instruction.keys.map(k => ({ ...k, pubkey: rebind.get(k.pubkey.toBase58()) ?? k.pubkey })),
    });
    return { swap: ix, minOut: BigInt(route.minOutRaw), expectedOut: BigInt(route.expectedOutRaw), venue: "raydium-clmm", lookupTables: route.lookupTables };
  };
}
