/** Copy-trade receipts, never wallet balances, index ownership, or NAV. */
export type TrackedPosition = {
  id: string;
  wallet: string;
  disclosureId: string | null;
  ticker: string;
  tokenSymbol: string;
  venue: "xstock" | "backpack";
  mint: string;
  side: "buy" | "sell";
  inputAmountRaw: string | null;
  outputAmountRaw: string | null;
  inputDecimals: number;
  outputDecimals: number;
  requestId: string;
  signature: string;
  stub: boolean;
  createdAt: string;
};

export type PositionRow = {
  id: string; wallet: string; disclosure_id: string | null; ticker: string;
  token_symbol: string; venue: TrackedPosition["venue"]; mint: string; side: TrackedPosition["side"];
  input_amount_raw: string | null; output_amount_raw: string | null;
  input_decimals: number; output_decimals: number;
  request_id: string; signature: string; stub: boolean; created_at: string;
};

export function positionToRow(p: TrackedPosition): PositionRow {
  return { id: p.id, wallet: p.wallet, disclosure_id: p.disclosureId, ticker: p.ticker,
    token_symbol: p.tokenSymbol, venue: p.venue, mint: p.mint, side: p.side,
    input_amount_raw: p.inputAmountRaw, output_amount_raw: p.outputAmountRaw,
    input_decimals: p.inputDecimals, output_decimals: p.outputDecimals,
    request_id: p.requestId, signature: p.signature, stub: p.stub, created_at: p.createdAt };
}

export function positionFromRow(p: PositionRow): TrackedPosition {
  return { id: p.id, wallet: p.wallet, disclosureId: p.disclosure_id, ticker: p.ticker,
    tokenSymbol: p.token_symbol, venue: p.venue, mint: p.mint, side: p.side,
    inputAmountRaw: p.input_amount_raw, outputAmountRaw: p.output_amount_raw,
    inputDecimals: p.input_decimals, outputDecimals: p.output_decimals,
    requestId: p.request_id, signature: p.signature, stub: p.stub, createdAt: p.created_at };
}

export function formatReceiptAmount(raw: string | null, decimals: number): string {
  if (raw === null || !/^\d+$/.test(raw) || !Number.isInteger(decimals) || decimals < 0 || decimals > 18) return "Unavailable";
  const digits = raw.padStart(decimals + 1, "0");
  if (!decimals) return digits;
  const fraction = digits.slice(-decimals).replace(/0+$/, "");
  return digits.slice(0, -decimals) + (fraction ? `.${fraction}` : "");
}
