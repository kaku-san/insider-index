/**
 * Verified xStocks mint allowlist for Stocklana V1.
 *
 * Buy is permitted only when the output mint is on this list.
 * Authority note (xStocks mint authority): S7vYFFWH6BjJyEsdrPQpqpYTqLTrPRK6KW3VwsJuRaS
 */

export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" as const;
export const USDC_DECIMALS = 6;

export const XSTOCKS_MINT_AUTHORITY =
  "S7vYFFWH6BjJyEsdrPQpqpYTqLTrPRK6KW3VwsJuRaS" as const;

export type XStock = {
  symbol: string;
  name: string;
  mint: string;
  decimals: number;
  /** Underlying equity tickers that map to this xStock. */
  underlyingTickers: readonly string[];
  /** Stub USD price used only when Jupiter is not configured. */
  stubUsdPrice: number;
};

export const XSTOCK_ALLOWLIST = [
  {
    symbol: "NVDAx",
    name: "NVIDIA xStock",
    mint: "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh",
    decimals: 8,
    underlyingTickers: ["NVDA"],
    stubUsdPrice: 178.4,
  },
  {
    symbol: "AAPLx",
    name: "Apple xStock",
    mint: "XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp",
    decimals: 8,
    underlyingTickers: ["AAPL"],
    stubUsdPrice: 228.15,
  },
  {
    symbol: "TSLAx",
    name: "Tesla xStock",
    mint: "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB",
    decimals: 8,
    underlyingTickers: ["TSLA"],
    stubUsdPrice: 246.8,
  },
  {
    symbol: "MSFTx",
    name: "Microsoft xStock",
    mint: "XspzcW1PRtgf6Wj92HCiZdjzKCyFekVD8P5Ueh3dRMX",
    decimals: 8,
    underlyingTickers: ["MSFT"],
    stubUsdPrice: 432.6,
  },
  {
    symbol: "METAx",
    name: "Meta xStock",
    mint: "Xsa62P5mvPszXL1krVUnU5ar38bBSVcWAB6fmPCo5Zu",
    decimals: 8,
    underlyingTickers: ["META"],
    stubUsdPrice: 584.2,
  },
  {
    symbol: "AMZNx",
    name: "Amazon xStock",
    mint: "Xs3eBt7uRfJX8QUs4suhyU8p2M6DoUDrJyWBa8LLZsg",
    decimals: 8,
    underlyingTickers: ["AMZN"],
    stubUsdPrice: 196.75,
  },
  {
    symbol: "GOOGLx",
    name: "Alphabet xStock",
    mint: "XsCPL9dNWBMvFtTmwcCA5v3xWPSMEBCszbQdiLLq6aN",
    decimals: 8,
    underlyingTickers: ["GOOGL", "GOOG"],
    stubUsdPrice: 168.9,
  },
  {
    symbol: "SPYx",
    name: "SPDR S&P 500 xStock",
    mint: "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W",
    decimals: 8,
    underlyingTickers: ["SPY"],
    stubUsdPrice: 562.3,
  },
  {
    symbol: "QQQx",
    name: "Invesco QQQ xStock",
    mint: "Xs8S1uUs1zvS2p7iwtsG3b6fkhpvmwz4GYU3gWAmWHZ",
    decimals: 8,
    underlyingTickers: ["QQQ"],
    stubUsdPrice: 489.1,
  },
  {
    symbol: "NFLXx",
    name: "Netflix xStock",
    mint: "XsEH7wWfJJu2ZT3UCFeVfALnVA6CP5ur7Ee11KmzVpL",
    decimals: 8,
    underlyingTickers: ["NFLX"],
    stubUsdPrice: 712.45,
  },
  {
    symbol: "COINx",
    name: "Coinbase xStock",
    mint: "Xs7ZdzSHLU9ftNJsii5fCeJhoRWSC32SQGzGQtePxNu",
    decimals: 8,
    underlyingTickers: ["COIN"],
    stubUsdPrice: 264.3,
  },
  {
    symbol: "MSTRx",
    name: "MicroStrategy xStock",
    mint: "XsP7xzNPvEHS1m6qfanPUGjNmdnmsLKEoNAnHjdxxyZ",
    decimals: 8,
    underlyingTickers: ["MSTR"],
    stubUsdPrice: 338.9,
  },
] as const satisfies readonly XStock[];

export type AllowlistedSymbol = (typeof XSTOCK_ALLOWLIST)[number]["symbol"];
export type AllowlistedMint = (typeof XSTOCK_ALLOWLIST)[number]["mint"];

const MINT_INDEX = new Map<string, XStock>(
  XSTOCK_ALLOWLIST.map((item) => [item.mint, item as XStock]),
);

const TICKER_INDEX = new Map<string, XStock>();
for (const item of XSTOCK_ALLOWLIST) {
  for (const ticker of item.underlyingTickers) {
    TICKER_INDEX.set(ticker.toUpperCase(), item as XStock);
  }
}

export const ALLOWLISTED_TICKERS: string[] = [
  ...new Set(XSTOCK_ALLOWLIST.flatMap((item) => [...item.underlyingTickers])),
].sort();

export function getXStockByMint(mint: string): XStock | undefined {
  return MINT_INDEX.get(mint);
}

export function getXStockByTicker(ticker: string): XStock | undefined {
  return TICKER_INDEX.get(ticker.trim().toUpperCase());
}

export function getXStockBySymbol(symbol: string): XStock | undefined {
  return XSTOCK_ALLOWLIST.find(
    (item) => item.symbol.toLowerCase() === symbol.toLowerCase(),
  ) as XStock | undefined;
}

export function isAllowlistedMint(mint: string): boolean {
  return MINT_INDEX.has(mint);
}

/** V1 rule: buy only if the output mint is a verified xStock on this list. */
export function canBuyMint(mint: string): boolean {
  return isAllowlistedMint(mint);
}

export function assertCanBuyMint(mint: string): XStock {
  const xstock = getXStockByMint(mint);
  if (!xstock) {
    throw new Error(
      `Mint ${mint} is not on the Stocklana V1 xStock allowlist. Buy is blocked.`,
    );
  }
  return xstock;
}

export function toAtomicAmount(uiAmount: number, decimals: number): string {
  const factor = 10 ** decimals;
  return Math.round(uiAmount * factor).toString();
}

export function fromAtomicAmount(atomic: string | number, decimals: number): number {
  return Number(atomic) / 10 ** decimals;
}
