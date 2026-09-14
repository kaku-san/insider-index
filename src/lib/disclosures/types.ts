/**
 * Where a row came from. Labelled honestly so the UI can badge live vs mock.
 *  - edgar-form4      SEC EDGAR Form 4 XML (primary insiders, no key)
 *  - form4            Form4API insiders (fallback, FORM4API_KEY)
 *  - ainvest-congress AInvest Congressional Trades (primary politicians, AINVEST_API_KEY)
 *  - congress         Form4API House PTRs (fallback, FORM4API_KEY)
 *  - mock-*           labelled fixtures; never served in production by default
 */
export type DisclosureSource =
  | "edgar-form4"
  | "form4"
  | "ainvest-congress"
  | "congress"
  | "mock-form4"
  | "mock-congress";

export type LaneSource = DisclosureSource | "off";

/** Per-lane provenance reported by GET /api/disclosures. */
export type LaneStatus = {
  source: LaneSource;
  live: boolean;
  count: number;
  /** Human-readable reason when the lane is degraded or off. */
  note: string | null;
};

export type DisclosureSide = "buy" | "sell" | "other";

export type ActorKind = "insider" | "politician";

export type PoliticalParty = "Democratic" | "Republican" | "Independent";

/**
 * Where a disclosed name can actually be bought.
 *  - xstock    verified xStock mint on Solana; in-app user-signed Jupiter swap
 *  - backpack  listed US-equity market on Backpack Exchange (spot or perp); external
 *  - none      disclosed, shown in the book, not tradable anywhere we wire yet
 */
export type Venue = "xstock" | "backpack" | "none";

export type VenueMarket = "swap" | "spot" | "perp";

export type VenueListing = {
  venue: Exclude<Venue, "none">;
  /** Venue-side symbol, e.g. `NVDAx` or `NVDA.US_USDC_PERP`. */
  symbol: string;
  market: VenueMarket;
  /** External trade link for venues we do not execute in-app. Null for xStocks. */
  href: string | null;
};

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
  /** Best venue for copying this name (xStock first, then Backpack, else none). */
  venue: Venue;
  venueSymbol: string | null;
  venueMarket: VenueMarket | null;
  venueHref: string | null;
  /** Buy/sell on a name we can route somewhere (any venue). */
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

/**
 * Per-horizon activity. Returns and hit rate are null until we can compute
 * them from dated trades and a real price series; never a synthetic number.
 */
export type HorizonInsight = {
  horizon: HorizonKey;
  returnPct: number | null;
  trades: number;
  /** Sum of reported midpoints; null when nothing in the window carried a size. */
  volumeUsd: number | null;
  /** Sum of the low / high bounds of the reported ranges (PTR size bands). */
  volumeLow: number | null;
  volumeHigh: number | null;
  hitRate: number | null;
};

/**
 * Current disclosed position status reconstructed from the filing history.
 *  - holding  net buys, no evidence of a full exit
 *  - reduced  buys and later sells, net still positive
 *  - exited   sells wiped out every disclosed buy
 *  - sold     only sells on record: they held it, size unknown
 */
export type HoldingStatus = "holding" | "reduced" | "exited" | "sold";

export type PortfolioHolding = {
  ticker: string;
  issuerName: string;
  xstockSymbol: string | null;
  xstockMint: string | null;
  venue: Venue;
  venueSymbol: string | null;
  venueMarket: VenueMarket | null;
  venueHref: string | null;
  /** Share of the estimated book (midpoint). 0 when the size is unknown. */
  weightPct: number;
  /** Estimated current value (midpoint of the net range). 0 when unknown. */
  valueUsd: number;
  valueLow: number | null;
  valueHigh: number | null;
  status: HoldingStatus;
  buys: number;
  sells: number;
  lastSide: DisclosureSide;
  firstTradeAt: string;
  lastTradeAt: string;
  /** Latest disclosure for this name (the print a copy would mirror). */
  latestDisclosureId: string;
  latestBuyDisclosureId: string | null;
  copyEligible: boolean;
};

export type IndexConstituent = {
  ticker: string;
  xstockSymbol: string | null;
  /** xStock mint for in-app swaps; null for legs routed to an external venue. */
  mint: string | null;
  venue: Exclude<Venue, "none">;
  venueSymbol: string;
  venueMarket: VenueMarket;
  venueHref: string | null;
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
  hitRate90d: number | null;
  copiedPnl90d: number | null;
  /** Full disclosed book: every ticker on the PTRs / Form 4s, tradable or not. */
  portfolio: PortfolioHolding[];
  /** Real equity series only. Empty until one exists; never synthetic. */
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
