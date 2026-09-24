/**
 * Mainnet mark + swap adapters for the NAV vault keeper. Marks: Jupiter v1 quote first (plain HTTP,
 * CPI-safe DEXes, no Solana RPC), the persisted Raydium pool quote (`buildCycleRoute`, direct CLMM)
 * only when Jupiter has no quote; never Pyth/Hermes. Quotes are built, never sent. A mark is the mid
 * of a $100 ask and the matching bid (sell-side) quote.
 * The deployed mainnet program and the newer committed binary are distinguished in docs/nav-vault.md.
 */
import { PublicKey, TransactionInstruction, type Connection } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { buildCycleRoute } from "../index-vaults/cycle-routes.ts";
import { MAINNET_USDC } from "./constants.ts";
import type { PersistedVaultLeg } from "../index-vaults/vault-definition-store.ts";
import { JUPITER_CPI_SAFE_DEXES, firstRoute, jupiterV1SwapBuilder, markFromQuote, type MarkSource, type SwapBuilder } from "./keeper.ts";
import { legAccount, legIndex } from "./program.ts";

export const MARK_PROBE_USDC_RAW = 100_000_000n; // $100 probe on each side of the book.

/** Bid/ask ratio per mint (parts per million), measured by a sell-side quote and re-measured every 5 minutes. */
export const BID_REFRESH_MS = 5 * 60_000;
/**
 * Sell-side re-quotes per mark round, so refreshing every bid never lands in one round (that round
 * doubled its quotes and let marks go stale). Mints with no measured spread yet get their own budget.
 */
export const BID_REFRESHES_PER_ROUND = 2;
export const BID_FIRST_QUOTES_PER_ROUND = 4;
export type BidSpreads = Map<string, { bidOverAskPpm: bigint | null; at: number }>;
const bidSpreads: BidSpreads = new Map();

/** Mid of an executable ask (USDC → leg) and bid (the same leg amount → USDC); the ask alone when no bid quotes. */
export function midMark(askPrice: bigint, bidPrice: bigint | null): bigint {
  if (!bidPrice || bidPrice <= 0n || bidPrice > askPrice) return askPrice;
  return (askPrice + bidPrice) / 2n;
}

/** One venue per mark round (`mainnetVenue` is built each round), so the bid budgets are per round. */
export function mainnetVenue(input: {
  connection: Connection; legs: readonly PersistedVaultLeg[]; quoteOwner: string; env?: { JUPITER_API_KEY?: string };
  fetchImpl?: typeof fetch; bidCache?: BidSpreads; now?: () => number;
}): { marks: MarkSource; swaps: SwapBuilder } {
  const fetchImpl = input.fetchImpl ?? fetch;
  const spreads = input.bidCache ?? bidSpreads;
  const now = input.now ?? Date.now;
  const apiKey = input.env?.JUPITER_API_KEY?.trim();
  let refreshes = BID_REFRESHES_PER_ROUND, firsts = BID_FIRST_QUOTES_PER_ROUND;
  const jupiterQuote = async (inputMint: string, outputMint: string, amountRaw: bigint): Promise<bigint | null> => {
    const url = new URL(apiKey ? "https://api.jup.ag/swap/v1/quote" : "https://lite-api.jup.ag/swap/v1/quote");
    url.searchParams.set("inputMint", inputMint); url.searchParams.set("outputMint", outputMint);
    url.searchParams.set("amount", amountRaw.toString()); url.searchParams.set("slippageBps", "50");
    url.searchParams.set("swapMode", "ExactIn"); url.searchParams.set("dexes", JUPITER_CPI_SAFE_DEXES.join(","));
    try {
      const response = await fetchImpl(url, { headers: { Accept: "application/json", ...(apiKey ? { "x-api-key": apiKey } : {}) }, signal: AbortSignal.timeout(15_000) });
      const quote = response.ok ? await response.json() as { outAmount?: string; inAmount?: string } : null;
      return quote?.outAmount && quote.inAmount === amountRaw.toString() && BigInt(quote.outAmount) > 0n ? BigInt(quote.outAmount) : null;
    } catch { return null; }
  };
  /** Executable output for `amountRaw` of `inputMint`: Jupiter (no RPC) first, then the persisted Raydium pool. */
  const quoteOut = async (persisted: PersistedVaultLeg | undefined, inputMint: string, outputMint: string, amountRaw: bigint): Promise<{ out: bigint; venue: string }> => {
    const jupiter = await jupiterQuote(inputMint, outputMint, amountRaw);
    if (jupiter) return { out: jupiter, venue: "jupiter-v1" };
    if (persisted?.pool && persisted.kind === "raydium_clmm") {
      const route = await buildCycleRoute({
        connection: input.connection, leg: persisted, owner: input.quoteOwner, inputMint, outputMint,
        amountInRaw: amountRaw.toString(), slippageBps: 50, maxAgeMs: 60_000,
      });
      return { out: BigInt(route.expectedOutRaw), venue: "raydium" };
    }
    throw new Error(`No Jupiter or Raydium quote for ${inputMint} → ${outputMint}.`);
  };
  // Marks are the mid of both sides, so NAV and the on-chain sell bound reflect what the vault can
  // realise, not the ask alone (an ask mark makes every sale look like a loss beyond max_slippage).
  // Bids are re-quoted a few mints per round (stalest first as they expire); between refreshes the
  // last measured spread is applied to the fresh ask, so a round costs about one quote per mint.
  const marks: MarkSource = async leg => {
    const persisted = input.legs.find(item => item.mint === leg.mint.toBase58());
    const mint = leg.mint.toBase58();
    const ask = await quoteOut(persisted, MAINNET_USDC, mint, MARK_PROBE_USDC_RAW).catch(error => { throw new Error(`No Jupiter or Raydium mark for ${mint}. ${(error as Error).message}`); });
    const askPrice = markFromQuote(MARK_PROBE_USDC_RAW, ask.out, leg.decimals);
    let spread = spreads.get(mint);
    const due = !spread ? firsts > 0 : now() - spread.at > BID_REFRESH_MS && refreshes > 0;
    if (due) {
      if (spread) refreshes -= 1; else firsts -= 1;
      const bid = await quoteOut(persisted, mint, MAINNET_USDC, ask.out).catch(() => null);
      const bidPrice = bid && bid.out > 0n ? (bid.out * 10n ** BigInt(leg.decimals)) / ask.out : null;
      spread = { bidOverAskPpm: bidPrice && bidPrice <= askPrice ? (bidPrice * 1_000_000n) / askPrice : null, at: now() };
      spreads.set(mint, spread);
    }
    const price = midMark(askPrice, !spread || spread.bidOverAskPpm === null ? null : (askPrice * spread.bidOverAskPpm) / 1_000_000n);
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
