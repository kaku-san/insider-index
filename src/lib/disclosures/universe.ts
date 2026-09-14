/**
 * Ticker universe for the congress lane.
 *
 * AInvest `/ownership/congress` is ticker-scoped (the `ticker` query param is
 * required; there is no per-member or unfiltered pull), so a Pelosi-Tracker
 * style book has to be assembled by querying a wide set of names and grouping
 * the rows by filer. Nothing here is a holding claim: a ticker in this list
 * only means "ask the source about it".
 *
 * Pure data, no env, no aliases — unit-tested directly with `node --test`.
 */

/** xStock underlyings. Kept in sync with src/lib/allowlist.ts by the test suite. */
export const XSTOCK_UNDERLYINGS = [
  "AAPL", "AMZN", "COIN", "GOOG", "GOOGL", "META", "MSFT", "MSTR", "NFLX", "NVDA", "QQQ", "SPY", "TSLA",
] as const;

/** Large-cap S&P names that show up on PTRs constantly. */
export const SP_CORE_TICKERS = [
  "AVGO", "AMD", "TSM", "ORCL", "CRM", "ADBE", "INTC", "CSCO", "QCOM", "TXN", "MU", "PLTR", "PANW", "CRWD", "NOW",
  "IBM", "UBER", "SHOP", "SNOW", "ARM", "ASML", "AMAT", "LRCX", "KLAC", "ANET", "DELL", "HPQ", "SMCI", "SNDK",
  "BRK.B", "JPM", "BAC", "WFC", "GS", "MS", "C", "SCHW", "BLK", "AXP", "V", "MA", "PYPL", "SQ", "HOOD", "CRCL",
  "UNH", "JNJ", "LLY", "PFE", "MRK", "ABBV", "TMO", "ABT", "CVS", "HUM", "CI", "MRNA", "GILD", "AMGN",
  "XOM", "CVX", "COP", "OXY", "SLB", "EOG", "PSX", "KMI",
  "WMT", "COST", "HD", "LOW", "TGT", "NKE", "SBUX", "MCD", "KO", "PEP", "PG", "PM", "MO", "DIS", "CMCSA", "T", "VZ", "TMUS",
  "BA", "LMT", "RTX", "GD", "NOC", "GE", "CAT", "DE", "HON", "UNP", "UPS", "FDX", "LUV", "DAL", "UAL",
  "LIN", "NEE", "DUK", "SO", "AMT", "PLD", "SPG",
  "IWM", "DIA", "VOO", "VTI", "GLD", "TLT", "IBIT", "ETHA",
] as const;

/** Names that recur on congressional PTRs beyond the S&P core. */
export const FREQUENT_PTR_TICKERS = [
  "RBLX", "DKNG", "ROKU", "SOFI", "RIVN", "LCID", "NIO", "BABA", "JD", "PDD", "SE", "MELI", "SPOT", "ABNB", "DASH",
  "COF", "USB", "PNC", "TFC", "BK", "STT", "KKR", "APO", "BX", "ICE", "CME", "MSCI", "SPGI",
  "ZM", "DOCU", "NET", "DDOG", "MDB", "TTD", "OKTA", "ZS", "TEAM", "WDAY", "INTU",
  "F", "GM", "TM", "STLA", "CCL", "RCL", "MAR", "HLT", "BKNG", "EXPE",
  "MPC", "VLO", "DVN", "HAL", "FCX", "NEM", "ALB", "CLF", "X", "NUE",
  "ADP", "PAYX", "FIS", "FISV", "GPN", "ETN", "EMR", "ITW", "PH", "TDG", "HII", "LHX",
  "CSX", "NSC", "WM", "RSG", "ECL", "SHW", "APD", "DOW", "DD",
  "ISRG", "SYK", "MDT", "BSX", "ZTS", "DHR", "REGN", "VRTX", "BIIB", "BMY", "ELV", "HCA",
  "TSN", "GIS", "KHC", "MDLZ", "CL", "KMB", "EL", "LULU", "TJX", "ROST", "DG", "DLTR", "KR", "CMG", "YUM",
  "ENPH", "FSLR", "PLUG", "CHPT", "RUN", "BE",
] as const;

export const WIDE_CONGRESS_UNIVERSE: readonly string[] = [
  ...new Set<string>([...XSTOCK_UNDERLYINGS, ...SP_CORE_TICKERS, ...FREQUENT_PTR_TICKERS]),
].sort();

/** Parse a comma/space separated env override into upper-case tickers. */
export function parseTickerList(value: string | null | undefined): string[] {
  if (!value) return [];
  return [...new Set(value.split(/[\s,]+/).map((token) => token.trim().toUpperCase()).filter(Boolean))].sort();
}
