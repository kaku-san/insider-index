export type DisclosureSource = "form4" | "congress" | "mock-form4";

export type DisclosureSide = "buy" | "sell" | "other";

export type Form4Transaction = {
  id: string;
  accessionNumber: string;
  ticker: string;
  issuerName: string;
  insiderName: string;
  insiderTitle: string | null;
  insiderCik: string;
  transactionCode: string;
  transactionDate: string;
  filedAt: string;
  sharesAmount: number;
  pricePerShare: number | null;
  transactionValue: number | null;
  sharesOwnedAfter: number | null;
  is10b51: boolean;
};

export type Disclosure = Form4Transaction & {
  source: DisclosureSource;
  side: DisclosureSide;
  xstockSymbol: string | null;
  xstockMint: string | null;
  tradeEligible: boolean;
};

export type Form4ListParams = {
  ticker?: string;
  code?: string;
  page?: number;
  perPage?: number;
};

export interface Form4Adapter {
  listTransactions(params?: Form4ListParams): Promise<Form4Transaction[]>;
  getTransaction(id: string): Promise<Form4Transaction | null>;
}
