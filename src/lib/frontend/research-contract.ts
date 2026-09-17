/**
 * Frontend-only shapes for the research APIs documented in docs/design-handoff/api/FE_CONTRACT.md.
 * Keep this deliberately narrow: if a field is not in the contract / saved person handoff, the UI
 * must not pretend it exists.
 */
export type ResearchPerson = {
  id: string;
  name: string;
  office?: string | null;
  position?: string | null;
  chamber?: "house" | "senate" | "unknown" | string | null;
  party?: string | null;
  state?: string | null;
  image?: string | null;
  publishedIndexHash?: string | null;
  indexName?: string | null;
  bookState?: string | null;
};

export type PeopleDirectoryResponse = {
  people: ResearchPerson[];
  total?: number;
  partial?: boolean;
  complete?: boolean;
  savedAt?: string | null;
  storage?: string;
};

export type MoneyBand = { low: number | null; high: number | null };

export type ResearchItem = {
  id: string;
  year?: number | null;
  referenceDate?: string | null;
  filingDate?: string | null;
  name?: string | null;
  ticker?: string | null;
  kind?: string | null;
  section?: string | null;
  category?: string | null;
  assetType?: string | null;
  formType?: string | null;
  owner?: string | null;
  comment?: string | null;
  valueRange?: MoneyBand;
  providerValue?: number | null;
  incomeRange?: MoneyBand;
  sourceUrl?: string | null;
  token?: { symbol?: string; issuer?: string; mint?: string } | null;
  mappingReason?: string | null;
};

export type ResearchSnapshot = {
  id: string;
  year?: number | null;
  referenceDate?: string | null;
  filingDate?: string | null;
  sourceUrl?: string | null;
  complete?: boolean;
  partial?: boolean;
  issues?: string[];
  items: ResearchItem[];
};

export type ResearchActivity = {
  id: string;
  name?: string | null;
  ticker?: string | null;
  kind?: string | null;
  owner?: string | null;
  transactionDate?: string | null;
  disclosureDate?: string | null;
  event?: string | null;
  amount?: MoneyBand;
  amountLabel?: string | null;
  assetType?: string | null;
  comment?: string | null;
  sourceUrl?: string | null;
};

export type PublishedConstituent = {
  ticker: string;
  mint: string;
  issuer: string;
  weight_bps: number;
  /** Weight in the full disclosed book before mapped legs are normalized to a 100% target. */
  book_weight_bps?: number;
  /** True only when an observed supported pool makes this mapped token usable by the native vault. */
  vault_ready?: boolean;
  /** Persisted Raydium–USDC pool status: `observed` (qualifying pool), `thin` (pool below the TVL safety floor), or `none` (no observed pool). */
  pool_status?: "observed" | "thin" | "none";
  /** Observed pool TVL in USD when known; `null` when no pool or TVL is unavailable. */
  pool_tvl_usd?: number | null;
  payload?: {
    evidencedMidpoint?: number | null;
  } | null;
};

export type PublishedIndex = {
  hash: string;
  person_id: string;
  indexName?: string;
  period?: string;
  version?: number;
  status?: string;
  published_at?: string;
  definition?: {
    basis?: string;
    methodology?: string;
    label?: string;
    evidence?: Array<{
      holding?: ResearchItem;
      ticker?: string | null;
      token?: { symbol?: string; issuer?: string; mint?: string } | null;
      method?: string | null;
      reason?: string | null;
    }>;
    excluded?: Array<{ holdingId?: string; ticker?: string | null; name?: string | null; reason?: string }>;
  };
  constituents: PublishedConstituent[];
};

export type PersonPortfolioResponse = {
  person: ResearchPerson;
  source?: string;
  storage?: string;
  savedAt?: string | null;
  state?: string;
  complete?: boolean;
  partial?: boolean;
  snapshots: ResearchSnapshot[];
  activity: ResearchActivity[];
  activityComplete?: boolean;
  publishedIndex?: PublishedIndex | null;
  indexName?: string | null;
  ingestion?: Record<string, { status?: string; count?: number; issues?: Array<{ code?: string }> }> | null;
};

export type PublishedIndexResponse = { index: PublishedIndex };
