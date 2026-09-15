import { PublicKey } from "@solana/web3.js";
import { address, rawAmount, weightsValid } from "./amounts.ts";
import { HOST_ENTRY_FEE_BPS, HOST_EXIT_FEE_BPS } from "./fees.ts";
import { discloseNativeCaps } from "./native-caps.ts";
import { assertQuoteVenue, requireQuotes, type VenueQuote } from "./vault-prices.ts";

export interface ZapAsset { mint: string; targetWeightBps: number }
export interface ZapHolding { mint: string; amountRaw: string }
export interface ZapLeg {
  mint: string;
  usdcInRaw: string;
  estimatedOutRaw: string;
  venue: VenueQuote["venue"];
  dust: boolean;
}
export interface ZapInPlan {
  kind: "zap-in";
  usdcMint: string;
  usdcInRaw: string;
  hostEntryFeeBps: typeof HOST_ENTRY_FEE_BPS;
  hostExitFeeBps: typeof HOST_EXIT_FEE_BPS;
  legs: ZapLeg[];
  unusedUsdcRaw: string;
  estimatedOnly: true;
  estimatedSharesRaw: null;
  caps: ReturnType<typeof discloseNativeCaps>;
  blockers: string[];
}
export interface ZapOutPlan {
  kind: "zap-out";
  usdcMint: string;
  hostEntryFeeBps: typeof HOST_ENTRY_FEE_BPS;
  hostExitFeeBps: typeof HOST_EXIT_FEE_BPS;
  userReceives: { mint: string; amountRaw: string }[];
  estimatedUsdcOutRaw: string;
  estimatedOnly: true;
  leftovers: { mint: string; amountRaw: string }[];
  blockers: string[];
}

const UNPROVEN = [
  "ZAP_UNPROVEN: no create→mint→rebalance→USDC-out receipt",
  "BROADCAST_DISABLED",
  "PREVIEW_ESTIMATED_NOT_GUARANTEED",
];

export function planZapIn(input: { usdcMint: string; usdcAmountRaw: string; assets: ZapAsset[]; quotes: readonly VenueQuote[] }): ZapInPlan {
  const usdcMint = address(input.usdcMint);
  const usdcIn = rawAmount(input.usdcAmountRaw, true);
  weightsValid(input.assets);
  const caps = discloseNativeCaps(input.assets.length);
  const quoted = requireQuotes(input.assets.map(a => a.mint), input.quotes);
  const legs: ZapLeg[] = [];
  let allocated = 0n;
  for (const asset of input.assets) {
    const mint = address(asset.mint);
    if (mint === usdcMint) throw new Error("ZAP_IN_USDC_LEG: zap-in buys mapped xStocks, not USDC");
    const quote = quoted.get(mint)!;
    if (quote.inMint !== usdcMint || quote.outMint !== mint) throw new Error(`ZAP_IN_QUOTE_DIRECTION: ${mint}`);
    assertQuoteVenue(quote);
    const usdcForLeg = usdcIn * BigInt(asset.targetWeightBps) / 10_000n;
    allocated += usdcForLeg;
    const quoteIn = rawAmount(quote.inAmountRaw, true);
    const quoteOut = rawAmount(quote.outAmountRaw, true);
    const estimatedOut = usdcForLeg === 0n || quoteIn === 0n ? 0n : quoteOut * usdcForLeg / quoteIn;
    legs.push({ mint, usdcInRaw: usdcForLeg.toString(), estimatedOutRaw: estimatedOut.toString(), venue: quote.venue, dust: usdcForLeg === 0n });
  }
  if (allocated > usdcIn) throw new Error("ZAP_IN_OVER_ALLOCATED");
  return {
    kind: "zap-in", usdcMint, usdcInRaw: usdcIn.toString(), hostEntryFeeBps: HOST_ENTRY_FEE_BPS, hostExitFeeBps: HOST_EXIT_FEE_BPS,
    legs, unusedUsdcRaw: (usdcIn - allocated).toString(), estimatedOnly: true, estimatedSharesRaw: null, caps,
    blockers: [...UNPROVEN, "UNUSED_USDC_RETURN_UNPROVEN", `HOST_ENTRY_${HOST_ENTRY_FEE_BPS}_BPS_AT_MINT`],
  };
}

export function planZapOut(input: { usdcMint: string; holdings: ZapHolding[]; quotes: readonly VenueQuote[] }): ZapOutPlan {
  const usdcMint = address(input.usdcMint);
  if (new Set(input.holdings.map(h => address(h.mint))).size !== input.holdings.length) throw new Error("Duplicate zap-out mint");
  const need = input.holdings.filter(h => h.mint !== usdcMint).map(h => h.mint);
  const quoted = need.length ? requireQuotes(need, input.quotes) : new Map();
  let usdc = 0n;
  const leftovers: { mint: string; amountRaw: string }[] = [];
  for (const holding of input.holdings) {
    const mint = address(holding.mint);
    const amount = rawAmount(holding.amountRaw);
    if (amount === 0n) continue;
    if (mint === usdcMint) { usdc += amount; continue; }
    const quote = quoted.get(mint)!;
    if (quote.inMint !== mint || quote.outMint !== usdcMint) throw new Error(`ZAP_OUT_QUOTE_DIRECTION: ${mint}`);
    assertQuoteVenue(quote);
    const quoteIn = rawAmount(quote.inAmountRaw, true);
    const quoteOut = rawAmount(quote.outAmountRaw, true);
    usdc += quoteIn === 0n ? 0n : quoteOut * amount / quoteIn;
  }
  const userReceives = [{ mint: usdcMint, amountRaw: usdc.toString() }];
  if (userReceives.some(r => r.mint !== usdcMint)) throw new Error("ZAP_OUT_MUST_BE_USDC");
  return {
    kind: "zap-out", usdcMint, hostEntryFeeBps: HOST_ENTRY_FEE_BPS, hostExitFeeBps: HOST_EXIT_FEE_BPS,
    userReceives, estimatedUsdcOutRaw: usdc.toString(), estimatedOnly: true, leftovers,
    blockers: [...UNPROVEN, "HOST_EXIT_0_BPS", "USER_MUST_NOT_RECEIVE_XSTOCK_BAG"],
  };
}

export function assertKeeperHotWallet(keeper: string, roles: { deployer: string; host: string; strategy: string }): string {
  const hot = address(keeper);
  if (hot === address(roles.deployer)) throw new Error("KEEPER_MUST_NOT_BE_DEPLOYER");
  if (hot === address(roles.host)) throw new Error("KEEPER_MUST_NOT_BE_HOST");
  if (hot === address(roles.strategy)) throw new Error("KEEPER_MUST_NOT_BE_STRATEGY");
  if (!PublicKey.isOnCurve(new PublicKey(hot))) throw new Error("KEEPER_MUST_BE_ON_CURVE_HOT_WALLET");
  return hot;
}

export interface KeeperCyclePlan {
  keeper: string;
  steps: ["update_prices", "rebalance"];
  signerKind: "keeper-hot-wallet";
  until: "on-target";
  caps: ReturnType<typeof discloseNativeCaps>;
  blockers: string[];
}

export function planKeeperCycle(input: { keeper: string; deployer: string; host: string; strategy: string; tokenCount: number; signerKind: string }): KeeperCyclePlan {
  if (input.signerKind !== "keeper-hot-wallet") throw new Error("KEEPER_NOT_USER_CLICK");
  const keeper = assertKeeperHotWallet(input.keeper, input);
  return {
    keeper, steps: ["update_prices", "rebalance"], signerKind: "keeper-hot-wallet", until: "on-target",
    caps: discloseNativeCaps(input.tokenCount),
    blockers: ["KEEPER_BROADCAST_DISABLED", "FULL_CYCLE_RECEIPT_REQUIRED", "PRICES_RAYDIUM_THEN_JUPITER_NEVER_PYTH"],
  };
}
