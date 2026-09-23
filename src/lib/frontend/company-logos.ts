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
  CRM: "Salesforce", ORCL: "Oracle", ORLY: "O’Reilly Automotive",
  V: "Visa", MA: "Mastercard", JPM: "JPMorgan Chase", GS: "Goldman Sachs",
  "BRK.B": "Berkshire Hathaway", BRKB: "Berkshire Hathaway", BA: "Boeing", LMT: "Lockheed Martin",
  GE: "GE Aerospace", RTX: "RTX", NOC: "Northrop Grumman", GD: "General Dynamics",
  IBIT: "iShares Bitcoin Trust ETF", VOO: "Vanguard S&P 500 ETF", IVV: "iShares Core S&P 500 ETF",
  QQQ: "Invesco QQQ", SPY: "SPDR S&P 500 ETF Trust", SBUX: "Starbucks",
  FDX: "FedEx", LUV: "Southwest Airlines", OTHER: "Other holdings",
};

export function companyNameFor(ticker: string, fallback?: string | null) {
  const clean = fallback?.replace(/\s+xStock$/i, "").replace(/\s+\.US$/i, "").trim();
  return COMPANY_NAMES[normalizedTicker(ticker)] ?? (clean && !/^(xstocks?|backpack|tokenized stock|stock token)$/i.test(clean) ? clean : ticker);
}
