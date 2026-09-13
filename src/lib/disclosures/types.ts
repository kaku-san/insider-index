export type DisclosureSource =
  | "form4"
  | "congress"
  | "mock-form4"
  | "mock-congress";

export type DisclosureSide = "buy" | "sell" | "other";

export type ActorKind = "insider" | "politician";

export type PoliticalParty = "Democratic" | "Republican" | "Independent";

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
  /** Null when the source only discloses a dollar range (Congress PTRs). */
  sharesAmount: number | null;
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
  kind: ActorKind;
  profileId: string;
  party: PoliticalParty | null;
  chamber: string | null;
  state: string | null;
  amountLow: number | null;
  amountHigh: number | null;
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

export type HorizonKey = "24h" | "30d" | "90d";

export type HorizonInsight = {
  horizon: HorizonKey;
  returnPct: number;
  trades: number;
  volumeUsd: number;
  hitRate: number | null;
};

export type PortfolioHolding = {
  ticker: string;
  xstockSymbol: string | null;
  xstockMint: string | null;
  weightPct: number;
  valueUsd: number;
  copyEligible: boolean;
};

export type IndexConstituent = {
  ticker: string;
  xstockSymbol: string;
  mint: string;
  weightPct: number;
  valueUsd: number;
};

export type BacktestPoint = {
  label: string;
  equity: number;
};

export type FomoProfile = {
  id: string;
  kind: ActorKind;
  name: string;
  handle: string;
  title: string;
  party: PoliticalParty | null;
  chamber: string | null;
  state: string | null;
  cikOrBioguide: string;
  imageUrl: string | null;
  followers: number;
  lastSignalAt: string;
  insights: HorizonInsight[];
  hitRate90d: number;
  copiedPnl90d: number;
  portfolio: PortfolioHolding[];
  curve: BacktestPoint[];
  latestSignalId: string | null;
  latestEligibleSignalId: string | null;
  index: PersonIndex;
};

export type PersonIndex = {
  id: string;
  profileId: string;
  name: string;
  imageUrl: string | null;
  kind: ActorKind;
  party: PoliticalParty | null;
  constituents: IndexConstituent[];
  lastDisclosureId: string | null;
  lastDisclosureAt: string | null;
};

export type CopySignal = Disclosure & {
  headline: string;
  fomoLabel: string;
  imageUrl: string | null;
};
