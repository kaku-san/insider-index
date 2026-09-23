import { PACKET_DATA_SIZE } from "@solana/web3.js";
import { rawAmount, weightsValid } from "./amounts.ts";
import { cycleMintRounding } from "./cycle-accounting.ts";
import { MAG7_INDEX_ID, MAG7_UNROUTABLE_AMOUNT } from "./mag7-deposit-slices.ts";
import { MAINNET_USDC } from "./native-defaults.ts";
import { discloseNativeCaps } from "./native-caps.ts";

/** Public in-kind zap. One code path for every deposits-enabled index: weights and mints come from the definition, not a Mag7 ticker list. */
export { MAG7_INDEX_ID, MAG7_UNROUTABLE_AMOUNT };
export const IN_KIND_SLIPPAGE_BPS = 50;
export const IN_KIND_STAGES = ["quote", "acquire", "contribute", "lock", "price-mint", "verify"] as const;

export type InKindLeg = { mint: string; ticker: string; targetWeightBps: number };
export type WeightedSlice = { mint: string; ticker: string; targetWeightBps: number; usdcInRaw: string };
export type InKindVenue = "jupiter" | "raydium";
export type InKindLegQuote = {
  mint: string;
  ticker: string;
  venue: InKindVenue;
  usdcInRaw: string;
  expectedOutRaw: string;
  minOutRaw: string;
};
export type InKindZapPlan = {
  kind: "in-kind-zap";
  indexId: string;
  amountRaw: string;
  legCount: number;
  slices: WeightedSlice[];
  quotes: InKindLegQuote[];
  allocatedUsdcRaw: string;
  leftoverUsdcRaw: string;
  keeperUsdcRaw: "0";
  usesAuctionPairs: false;
  venues: InKindVenue[];
  packaging: "atomic" | "resumable";
  stages: typeof IN_KIND_STAGES;
  /** Bought tokens and unspent USDC stay in the user wallet until every quoted leg is acquired. */
  resume: string;
};
export type ObservedZap = {
  targetCount: number;
  bought: { ticker: string; mint: string; amountRaw: string }[];
  missing: { ticker: string; mint: string }[];
  complete: boolean;
  /** Null unless every quoted leg was actually acquired. Never the target count of a partial basket. */
  claimCount: number | null;
  leftoverUsdcRaw: string;
  statusLine: string;
};

const RESUME = "Bought tokens and unspent USDC stay in your wallet. Missing names can be retried. Nothing is contributed until every quoted name is bought.";

export function unroutableLegMessage(indexId: string, ticker: string): string {
  if (indexId === MAG7_INDEX_ID) return MAG7_UNROUTABLE_AMOUNT;
  const name = ticker.trim();
  return name ? `This amount cannot buy ${name} right now.` : "This amount cannot buy this index right now.";
}

/** Integer weighted split. Rounding dust is leftover USDC and is not a contribution. */
export function planWeightedUsdcSlices(amountRaw: string, legs: readonly InKindLeg[]): { slices: WeightedSlice[]; allocatedUsdcRaw: string; leftoverUsdcRaw: string } {
  const amount = rawAmount(amountRaw, true);
  if (!legs.length) throw new Error("This index has no investment legs.");
  discloseNativeCaps(legs.length);
  weightsValid(legs.map(leg => ({ mint: leg.mint, targetWeightBps: leg.targetWeightBps })));
  if (new Set(legs.map(leg => leg.ticker)).size !== legs.length) throw new Error("Investment legs need distinct tickers.");
  let allocated = 0n;
  const slices = legs.map(leg => {
    const usdc = amount * BigInt(leg.targetWeightBps) / 10_000n;
    allocated += usdc;
    return { mint: leg.mint, ticker: leg.ticker, targetWeightBps: leg.targetWeightBps, usdcInRaw: usdc.toString() };
  });
  if (allocated > amount) throw new Error("IN_KIND_OVER_ALLOCATED");
  return { slices, allocatedUsdcRaw: allocated.toString(), leftoverUsdcRaw: (amount - allocated).toString() };
}

export function assertQuotesCoverSlices(indexId: string, slices: readonly WeightedSlice[], quotes: readonly InKindLegQuote[]): void {
  const byMint = new Map<string, InKindLegQuote>();
  for (const quote of quotes) {
    if (quote.venue !== "jupiter" && quote.venue !== "raydium") throw new Error(unroutableLegMessage(indexId, quote.ticker));
    if (byMint.has(quote.mint)) throw new Error(unroutableLegMessage(indexId, quote.ticker));
    byMint.set(quote.mint, quote);
  }
  for (const slice of slices) {
    const quote = byMint.get(slice.mint);
    if (slice.usdcInRaw === "0" || !quote || quote.usdcInRaw !== slice.usdcInRaw || quote.ticker !== slice.ticker) {
      throw new Error(unroutableLegMessage(indexId, slice.ticker));
    }
    const minOut = rawAmount(quote.minOutRaw, true);
    if (minOut === 0n || rawAmount(quote.expectedOutRaw) < minOut) throw new Error(unroutableLegMessage(indexId, slice.ticker));
  }
  if (byMint.size !== slices.length) throw new Error(unroutableLegMessage(indexId, slices[0]?.ticker ?? ""));
}

/** Jupiter is preferred. A Raydium quote is only the fallback the caller already selected. Auction pairs are not an input. */
export function planInKindZap(input: {
  indexId: string;
  amountRaw: string;
  legs: readonly InKindLeg[];
  quotes: readonly InKindLegQuote[];
  /** Serialized bytes of a single all-leg transaction, when one was actually built. Over PACKET_DATA_SIZE is resumable, not a hang. */
  atomicBytes?: number | null;
}): InKindZapPlan {
  if (input.indexId === MAG7_INDEX_ID && (input.legs.length !== 7 || new Set(input.legs.map(leg => leg.mint)).size !== 7)) {
    throw new Error("Mag7 requires seven distinct investment legs before accepting a deposit.");
  }
  const weighted = planWeightedUsdcSlices(input.amountRaw, input.legs);
  const zero = weighted.slices.find(slice => slice.usdcInRaw === "0");
  if (zero) throw new Error(unroutableLegMessage(input.indexId, zero.ticker));
  assertQuotesCoverSlices(input.indexId, weighted.slices, input.quotes);
  const atomic = typeof input.atomicBytes === "number" && input.atomicBytes > 0 && input.atomicBytes <= PACKET_DATA_SIZE;
  return {
    kind: "in-kind-zap",
    indexId: input.indexId,
    amountRaw: rawAmount(input.amountRaw, true).toString(),
    legCount: input.legs.length,
    slices: weighted.slices,
    quotes: input.quotes.map(quote => ({ ...quote })),
    allocatedUsdcRaw: weighted.allocatedUsdcRaw,
    leftoverUsdcRaw: weighted.leftoverUsdcRaw,
    keeperUsdcRaw: "0",
    usesAuctionPairs: false,
    venues: [...new Set(input.quotes.map(quote => quote.venue))],
    packaging: atomic ? "atomic" : "resumable",
    stages: IN_KIND_STAGES,
    resume: RESUME,
  };
}

export function zapStatusLine(observed: { targetCount: number; bought: { ticker: string }[]; missing: { ticker: string }[]; complete: boolean }): string {
  if (observed.targetCount < 1) return "No names were quoted. Nothing was spent.";
  if (!observed.bought.length) return `Bought none of ${observed.targetCount} names. Shares were not minted.`;
  const names = observed.bought.map(leg => leg.ticker).join(", ");
  if (!observed.complete) {
    const missed = observed.missing.map(leg => leg.ticker).join(", ");
    return `Bought ${names} (${observed.bought.length} of ${observed.targetCount}). Not bought: ${missed}. Shares were not minted.`;
  }
  return `Bought ${names} (${observed.targetCount} of ${observed.targetCount}).`;
}

function asMap(value: ReadonlyMap<string, string> | Record<string, string>): Map<string, string> {
  return value instanceof Map ? value : new Map(Object.entries(value));
}

/** Partial fills stay in the wallet. claimCount is null until every leg clears its quoted minimum. */
export function observeAcquisition(input: {
  legs: readonly { mint: string; ticker: string }[];
  acquiredRawByMint: ReadonlyMap<string, string> | Record<string, string>;
  minimumRawByMint: ReadonlyMap<string, string> | Record<string, string>;
  leftoverUsdcRaw: string;
}): ObservedZap {
  const acquired = asMap(input.acquiredRawByMint);
  const minimum = asMap(input.minimumRawByMint);
  const bought: ObservedZap["bought"] = [];
  const missing: ObservedZap["missing"] = [];
  for (const leg of input.legs) {
    const got = rawAmount(acquired.get(leg.mint) ?? "0");
    const min = rawAmount(minimum.get(leg.mint) ?? "1", true);
    if (got >= min) bought.push({ ticker: leg.ticker, mint: leg.mint, amountRaw: got.toString() });
    else missing.push({ ticker: leg.ticker, mint: leg.mint });
  }
  const complete = missing.length === 0 && bought.length === input.legs.length && input.legs.length > 0;
  const observed = { targetCount: input.legs.length, bought, missing, complete, claimCount: complete ? input.legs.length : null, leftoverUsdcRaw: rawAmount(input.leftoverUsdcRaw).toString(), statusLine: "" };
  observed.statusLine = zapStatusLine(observed);
  return observed;
}

/** In-kind contribution is the acquired tokens, never USDC and never a partial basket. */
export function contributionsFromObservation(observed: ObservedZap): { mint: string; amount: string }[] {
  if (!observed.complete || observed.claimCount !== observed.targetCount || observed.bought.length !== observed.targetCount) {
    throw new Error("IN_KIND_INCOMPLETE_DO_NOT_CONTRIBUTE");
  }
  if (observed.bought.some(leg => leg.mint === MAINNET_USDC)) throw new Error("IN_KIND_USDC_CONTRIBUTION_FORBIDDEN");
  return observed.bought.map(leg => ({ mint: leg.mint, amount: rawAmount(leg.amountRaw, true).toString() }));
}

export type SwapBalanceRow = { mint: string; owner: string; amountRaw: string };
export function attributeSwapDeltas(input: {
  owner: string;
  legs: readonly { mint: string }[];
  usdcMint?: string;
  signatures: readonly { signature: string; pre: readonly SwapBalanceRow[]; post: readonly SwapBalanceRow[] }[];
}): { acquiredRawByMint: Record<string, string>; usdcSpentRaw: string } {
  const seen = new Set<string>();
  const legMints = new Set(input.legs.map(leg => leg.mint));
  const acquired = new Map(input.legs.map(leg => [leg.mint, 0n]));
  let spent = 0n;
  const usdc = input.usdcMint ?? MAINNET_USDC;
  for (const row of input.signatures) {
    if (!row.signature || seen.has(row.signature)) throw new Error("IN_KIND_SIGNATURE_REPLAY");
    seen.add(row.signature);
    const before = new Map<string, bigint>();
    const after = new Map<string, bigint>();
    for (const token of row.pre) if (token.owner === input.owner) before.set(token.mint, (before.get(token.mint) ?? 0n) + rawAmount(token.amountRaw));
    for (const token of row.post) if (token.owner === input.owner) after.set(token.mint, (after.get(token.mint) ?? 0n) + rawAmount(token.amountRaw));
    for (const mint of new Set([...before.keys(), ...after.keys()])) {
      const delta = (after.get(mint) ?? 0n) - (before.get(mint) ?? 0n);
      if (mint === usdc) {
        if (delta > 0n) throw new Error("IN_KIND_USDC_CREDIT_NOT_A_BUY");
        spent += -delta;
      } else if (legMints.has(mint)) {
        if (delta < 0n) throw new Error("IN_KIND_LEG_DEBIT_NOT_A_BUY");
        acquired.set(mint, (acquired.get(mint) ?? 0n) + delta);
      } else if (delta < 0n) {
        throw new Error("IN_KIND_UNEXPECTED_TOKEN_DEBIT");
      }
    }
  }
  return {
    acquiredRawByMint: Object.fromEntries([...acquired].map(([mint, amount]) => [mint, amount.toString()])),
    usdcSpentRaw: spent.toString(),
  };
}

/** Early mint only for a complete in-kind basket. Incomplete books do not mint and do not borrow keeper USDC. */
export function inKindMintDecision(input: {
  legs: readonly { mint: string }[];
  tokens: readonly { mint: string; amount: string }[];
  wsolMint: string;
}): { mint: boolean; reason: "complete-basket" | "incomplete-basket" | "support-unreconciled" | "empty-book"; bought: string[]; missing: string[]; leftoverUsdcRaw: string } {
  const amounts = new Map(input.tokens.map(token => [token.mint, rawAmount(token.amount)]));
  const leftoverUsdcRaw = (amounts.get(MAINNET_USDC) ?? 0n).toString();
  const bought = input.legs.filter(leg => (amounts.get(leg.mint) ?? 0n) > 0n).map(leg => leg.mint);
  const missing = input.legs.filter(leg => !bought.includes(leg.mint)).map(leg => leg.mint);
  if ((amounts.get(input.wsolMint) ?? 0n) > 0n) return { mint: false, reason: "support-unreconciled", bought, missing, leftoverUsdcRaw };
  if (!bought.length) return { mint: false, reason: "empty-book", bought, missing, leftoverUsdcRaw };
  if (missing.length || bought.length !== input.legs.length) return { mint: false, reason: "incomplete-basket", bought, missing, leftoverUsdcRaw };
  return { mint: true, reason: "complete-basket", bought, missing, leftoverUsdcRaw };
}

/** Share-lot rounding is disclosed. A bootstrap owner of the whole basket is not a lost dollar. Exact continuous proportions are not claimed. */
export function discloseInKindRounding(input: { beforeSupply: string; grossMinted: string; beforeValueQ: bigint; contributedValueQ: bigint; usdcPriceQ: bigint }) {
  const rounding = cycleMintRounding(input);
  return { ...rounding, disclosed: true as const, exactContinuousProportions: false as const };
}

export type SliceExecution = { mint: string; venue: InKindVenue; expectedOutRaw: string; minOutRaw: string };
export async function quoteInKindSlices(input: {
  indexId: string;
  amountRaw: string;
  legs: readonly InKindLeg[];
  jupiter: (slice: WeightedSlice) => Promise<SliceExecution | null>;
  raydium: (slice: WeightedSlice) => Promise<SliceExecution | null>;
  atomicBytes?: number | null;
  /** Already-bought mints are not quoted again and are not spent again. */
  onlyMints?: readonly string[];
}): Promise<{ plan: InKindZapPlan; executions: SliceExecution[] }> {
  const weighted = planWeightedUsdcSlices(input.amountRaw, input.legs);
  const wanted = input.onlyMints ? new Set(input.onlyMints) : null;
  const executions: SliceExecution[] = [];
  const quotes: InKindLegQuote[] = [];
  for (const slice of weighted.slices) {
    if (wanted && !wanted.has(slice.mint)) continue;
    if (slice.usdcInRaw === "0") throw new Error(unroutableLegMessage(input.indexId, slice.ticker));
    let execution: SliceExecution | null = null;
    try { execution = await input.jupiter(slice); } catch (error) {
      if (error instanceof Error && /API key/i.test(error.message)) throw error;
      execution = null;
    }
    if (!execution || execution.venue !== "jupiter" || execution.mint !== slice.mint) {
      try { execution = await input.raydium(slice); } catch { execution = null; }
    }
    if (!execution || execution.mint !== slice.mint || (execution.venue !== "jupiter" && execution.venue !== "raydium")) {
      throw new Error(unroutableLegMessage(input.indexId, slice.ticker));
    }
    executions.push(execution);
    quotes.push({
      mint: execution.mint, ticker: slice.ticker, venue: execution.venue, usdcInRaw: slice.usdcInRaw,
      expectedOutRaw: execution.expectedOutRaw, minOutRaw: execution.minOutRaw,
    });
  }
  if (!quotes.length) throw new Error(unroutableLegMessage(input.indexId, input.legs[0]?.ticker ?? ""));
  if (!wanted) return { plan: planInKindZap({ ...input, quotes, atomicBytes: input.atomicBytes }), executions };
  const slices = weighted.slices.filter(slice => wanted.has(slice.mint));
  const allocated = slices.reduce((sum, slice) => sum + BigInt(slice.usdcInRaw), 0n);
  return {
    plan: {
      kind: "in-kind-zap", indexId: input.indexId, amountRaw: rawAmount(input.amountRaw, true).toString(),
      legCount: input.legs.length, slices, quotes, allocatedUsdcRaw: allocated.toString(),
      leftoverUsdcRaw: (rawAmount(input.amountRaw, true) - allocated).toString(), keeperUsdcRaw: "0", usesAuctionPairs: false,
      venues: [...new Set(quotes.map(quote => quote.venue))], packaging: "resumable", stages: IN_KIND_STAGES,
      resume: "Bought tokens and unspent USDC stay in your wallet. Missing names can be retried. Nothing is contributed until every quoted name is bought.",
    },
    executions,
  };
}
