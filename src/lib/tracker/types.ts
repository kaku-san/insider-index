export type TrackerHolding = {
  ticker: string | null;
  name: string | null;
  value: number | null;
  percentage: number | null;
};

export type TrackerTrade = {
  date: string | null;
  amount: number | null;
  ticker: string | null;
  type: string | null;
  notificationDate: string | null;
};

export type TrackerPoint = { date: string | null; value: number | null };

export type TrackerPerson = {
  id: string;
  slug: string;
  rank: number;
  name: string;
  party: string | null;
  state: string | null;
  title: string | null;
  chamber: string | null;
  district: string | null;
  bio: string | null;
  image: string | null;
  asOf: string;
  source: string;
  sourceUrl: string | null;
  portfolioValue: number | null;
  cashValue: number | null;
  monthlyChangePercent: number | null;
  filingStats: Record<string, unknown> | null;
  sectors: unknown[];
  holdings: TrackerHolding[];
  trades: TrackerTrade[];
  performance: TrackerPoint[];
};

export type TrackerListResponse = {
  asOf: string;
  source: string;
  label: string;
  count: number;
  people: TrackerPerson[];
};

export type TrackerPersonResponse = {
  asOf: string;
  source: string;
  label: string;
  person: TrackerPerson;
};
