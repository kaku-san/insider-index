import { rawAmount } from "./amounts.ts";
export interface NativeNavInput {
  network: "devnet" | "mainnet-beta"; vault: string; slot: number; timestamp: number;
  denomination: "USD" | "USDC"; effectiveSupplyRaw: string; shareDecimals: number;
  /** Effective native backing only: exclude pending deposits, claims, fees and bounties exactly once. */
  accountingReconciled: boolean; liabilitiesQuoteRaw: string; quoteDecimals: number;
  assets: { mint: string; activeRaw: string; decimals: number; priceQuoteRaw: string;
    denomination: "USD" | "USDC"; priceBasis: "base-token" | "scaled-ui-token" | "unknown";
    multiplierNumerator: string; multiplierDenominator: string; priceTimestamp: number; multiplierTimestamp: number;
  }[];
}
/** Reporting only. Never computes a mint/burn instruction or replaces native supply. */
export function nativeNav(input: NativeNavInput, maxAgeMs: number): { navQuoteRaw: string | null; pricePerShareQuoteRaw: string | null; reason: string | null; netOfAccountedFees: true } {
  const unavailable = (reason: string) => ({ navQuoteRaw: null, pricePerShareQuoteRaw: null, reason, netOfAccountedFees: true as const });
  if (!Number.isFinite(input.timestamp) || !Number.isSafeInteger(input.slot) || input.slot < 1 || !Number.isFinite(maxAgeMs) || maxAgeMs <= 0) throw new Error("Invalid NAV observation/freshness policy");
  if (!input.accountingReconciled) return unavailable("Native effective backing/fee/claim accounting not reconciled");
  const decimals = [input.shareDecimals, input.quoteDecimals, ...input.assets.map(a => a.decimals)];
  if (decimals.some(d => !Number.isInteger(d) || d < 0 || d > 18)) throw new Error("Unsupported decimal precision");
  if (new Set(input.assets.map(a => a.mint)).size !== input.assets.length) throw new Error("Duplicate NAV mint");
  let total = 0n;
  for (const asset of input.assets) {
    if (asset.denomination !== input.denomination || asset.priceBasis === "unknown") return unavailable("Unknown or mixed price denomination/basis");
    if (!Number.isFinite(asset.priceTimestamp) || asset.priceTimestamp > input.timestamp || input.timestamp - asset.priceTimestamp > maxAgeMs) return unavailable("Stale price");
    let numerator = 1n, denominator = 1n;
    if (asset.priceBasis === "scaled-ui-token") {
      if (!Number.isFinite(asset.multiplierTimestamp) || asset.multiplierTimestamp > input.timestamp || input.timestamp - asset.multiplierTimestamp > maxAgeMs) return unavailable("Stale multiplier");
      numerator = rawAmount(asset.multiplierNumerator, true); denominator = rawAmount(asset.multiplierDenominator, true);
    }
    total += rawAmount(asset.activeRaw) * rawAmount(asset.priceQuoteRaw, true) * numerator / (10n ** BigInt(asset.decimals) * denominator);
  }
  const liabilities = rawAmount(input.liabilitiesQuoteRaw);
  if (liabilities > total) return unavailable("Native liabilities exceed marked backing");
  const nav = total - liabilities, supply = rawAmount(input.effectiveSupplyRaw);
  return { navQuoteRaw: nav.toString(), pricePerShareQuoteRaw: supply === 0n ? null : (nav * 10n ** BigInt(input.shareDecimals) / supply).toString(), reason: supply === 0n ? "Native bootstrap/donation accounting required" : null, netOfAccountedFees: true };
}
