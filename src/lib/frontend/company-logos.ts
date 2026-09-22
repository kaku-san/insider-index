const ACTUAL_LOGOS = new Set([
  "AAPL", "AMZN", "AVGO", "BE", "CRWD", "GOOGL", "IBTA", "INTC", "META",
  "MSFT", "NVDA", "OTHER", "PANW", "TEM", "TSLA", "UBER", "VST",
]);

function normalizedTicker(ticker: string) {
  return ticker.toUpperCase().replace(/\.L$/i, "").replace(/[^A-Z0-9.-]/g, "");
}

/**
 * Local assets supplied by the content pack. Actual marks are preferred where supplied;
 * the complete ticker fallback set keeps an unavailable mark from becoming a blank icon.
 */
export function companyLogoFor(ticker: string) {
  const symbol = normalizedTicker(ticker);
  const directory = ACTUAL_LOGOS.has(symbol) ? "actual" : "fallback";
  return `/index-assets/logos/${directory}/${symbol}.svg`;
}

export const COMPANY_NAMES: Record<string, string> = {
  NVDA: "NVIDIA", GOOGL: "Alphabet", GOOG: "Alphabet", BE: "Bloom Energy",
  AVGO: "Broadcom", PANW: "Palo Alto Networks", INTC: "Intel", VST: "Vistra",
  CRWD: "CrowdStrike", AMZN: "Amazon", TEM: "Tempus AI", AAPL: "Apple",
  MSFT: "Microsoft", TSLA: "Tesla", UBER: "Uber", META: "Meta",
  IBTA: "iShares Treasury Bond ETF",
};

export function companyNameFor(ticker: string, fallback?: string | null) {
  return COMPANY_NAMES[normalizedTicker(ticker)] ?? fallback ?? ticker;
}
