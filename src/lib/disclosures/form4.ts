import { ALLOWLISTED_TICKERS, getXStockByTicker } from "@/lib/allowlist";
import { MOCK_FORM4_TRANSACTIONS } from "@/lib/disclosures/mock-form4";
import type {
  Disclosure,
  Form4Adapter,
  Form4ListParams,
  Form4Transaction,
} from "@/lib/disclosures/types";

const FORM4_API_BASE = "https://api.form4api.com";

function toSide(code: string): Disclosure["side"] {
  if (code === "P") return "buy";
  if (code === "S") return "sell";
  return "other";
}

export function enrichDisclosure(
  tx: Form4Transaction,
  source: Disclosure["source"],
): Disclosure {
  const xstock = getXStockByTicker(tx.ticker);
  const side = toSide(tx.transactionCode);
  return {
    ...tx,
    source,
    side,
    xstockSymbol: xstock?.symbol ?? null,
    xstockMint: xstock?.mint ?? null,
    tradeEligible: Boolean(xstock) && (side === "buy" || side === "sell"),
    kind: "insider",
    profileId: `insider-${tx.insiderCik || tx.insiderName.toLowerCase().replace(/\s+/g, "-")}`,
    party: null,
    chamber: null,
    state: null,
    amountLow: tx.transactionValue,
    amountHigh: tx.transactionValue,
  };
}

function filterTransactions(
  items: Form4Transaction[],
  params: Form4ListParams = {},
): Form4Transaction[] {
  const ticker = params.ticker?.trim().toUpperCase();
  const code = params.code?.trim().toUpperCase();
  const page = params.page ?? 1;
  const perPage = params.perPage ?? 25;
  const allowedCodes = code
    ? new Set([code])
    : new Set(["P", "S"]);

  const filtered = items.filter((item) => {
    if (!item.ticker?.trim()) return false;
    if (ticker && item.ticker.toUpperCase() !== ticker) return false;
    if (!allowedCodes.has(item.transactionCode.toUpperCase())) return false;
    if (!ALLOWLISTED_TICKERS.includes(item.ticker.toUpperCase())) return false;
    return true;
  });

  filtered.sort(
    (a, b) => +new Date(b.filedAt || b.transactionDate) - +new Date(a.filedAt || a.transactionDate),
  );

  const start = (page - 1) * perPage;
  return filtered.slice(start, start + perPage);
}

function createMockForm4Adapter(): Form4Adapter {
  return {
    async listTransactions(params = {}) {
      return filterTransactions(MOCK_FORM4_TRANSACTIONS, params);
    },
    async getTransaction(id: string) {
      return MOCK_FORM4_TRANSACTIONS.find((item) => item.id === id) ?? null;
    },
  };
}

type Form4ApiTransaction = Partial<Form4Transaction> & {
  id?: string;
  accession_number?: string;
  issuer_name?: string;
  insider_name?: string;
  insider_title?: string;
  insider_cik?: string;
  transaction_code?: string;
  transaction_date?: string;
  filed_at?: string;
  shares_amount?: number;
  price_per_share?: number;
  transaction_value?: number;
  shares_owned_after?: number;
  is_10b5_1?: boolean;
};

function normalizeApiTransaction(
  raw: Form4ApiTransaction,
  index: number,
): Form4Transaction {
  const ticker = (raw.ticker ?? "").toUpperCase();
  const accessionNumber = raw.accessionNumber ?? raw.accession_number ?? `unknown-${index}`;
  const sharesRaw = raw.sharesAmount ?? raw.shares_amount;
  return {
    id: raw.id ?? `${accessionNumber}-${ticker}-${index}`,
    accessionNumber,
    ticker,
    issuerName: raw.issuerName ?? raw.issuer_name ?? ticker,
    insiderName: raw.insiderName ?? raw.insider_name ?? "Unknown insider",
    insiderTitle: raw.insiderTitle ?? raw.insider_title ?? null,
    insiderCik: raw.insiderCik ?? raw.insider_cik ?? "",
    transactionCode: raw.transactionCode ?? raw.transaction_code ?? "P",
    transactionDate: raw.transactionDate ?? raw.transaction_date ?? "",
    filedAt: raw.filedAt ?? raw.filed_at ?? "",
    sharesAmount: sharesRaw == null ? null : Number(sharesRaw),
    pricePerShare: raw.pricePerShare ?? raw.price_per_share ?? null,
    transactionValue: raw.transactionValue ?? raw.transaction_value ?? null,
    sharesOwnedAfter: raw.sharesOwnedAfter ?? raw.shares_owned_after ?? null,
    is10b51: raw.is10b51 ?? raw.is_10b5_1 ?? false,
  };
}

async function fetchForm4Page(
  apiKey: string,
  params: { ticker?: string; code?: string; page?: number; perPage?: number },
): Promise<Form4Transaction[]> {
  const search = new URLSearchParams();
  search.set("per_page", String(params.perPage ?? 25));
  search.set("page", String(params.page ?? 1));
  // Open-market buys and sells — Form 4 CEO activity is mostly sales.
  if (params.code) {
    search.set("code", params.code);
  } else {
    search.set("codes", "P,S");
  }
  if (params.ticker) {
    search.set("ticker", params.ticker);
  }

  const response = await fetch(
    `${FORM4_API_BASE}/v1/transactions?${search.toString()}`,
    {
      headers: { "X-Api-Key": apiKey },
      next: { revalidate: 60 },
    },
  );

  if (!response.ok) {
    throw new Error(`Form4API ${response.status}`);
  }

  const payload = (await response.json()) as
    | Form4ApiTransaction[]
    | { data?: Form4ApiTransaction[] };
  const rows = Array.isArray(payload) ? payload : (payload.data ?? []);
  return rows.map(normalizeApiTransaction);
}

function dedupeTransactions(rows: Form4Transaction[]): Form4Transaction[] {
  const seen = new Set<string>();
  const out: Form4Transaction[] = [];
  for (const row of rows) {
    const key = row.id || `${row.accessionNumber}-${row.ticker}-${row.transactionDate}-${row.sharesAmount}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

function createLiveForm4Adapter(apiKey: string): Form4Adapter {
  const mock = createMockForm4Adapter();

  return {
    async listTransactions(params = {}) {
      try {
        const tickers = params.ticker
          ? [params.ticker.trim().toUpperCase()]
          : ALLOWLISTED_TICKERS;
        const perTicker = Math.max(
          8,
          Math.ceil((params.perPage ?? 50) / Math.max(tickers.length, 1)),
        );

        const batches = await Promise.all(
          tickers.map(async (ticker) => {
            try {
              return await fetchForm4Page(apiKey, {
                ticker,
                code: params.code,
                page: 1,
                perPage: Math.min(perTicker, 50),
              });
            } catch {
              return [] as Form4Transaction[];
            }
          }),
        );

        const merged = dedupeTransactions(batches.flat());
        const filtered = filterTransactions(merged, {
          ...params,
          // Already fetched page 1 per ticker; apply local paging on the merge.
          page: params.page ?? 1,
        });

        // Live unfiltered pages were mostly non-allowlisted, which wiped the
        // Executives lane. Prefer mock fixtures over an empty allowlisted tape.
        if (filtered.length === 0) {
          return mock.listTransactions(params);
        }
        return filtered;
      } catch {
        return mock.listTransactions(params);
      }
    },
    async getTransaction(id: string) {
      const listed = await this.listTransactions({ perPage: 100 });
      return listed.find((item) => item.id === id) ?? mock.getTransaction(id);
    },
  };
}

export function createForm4Adapter(options?: { apiKey?: string }): Form4Adapter {
  const apiKey = options?.apiKey ?? process.env.FORM4API_KEY;
  if (apiKey) {
    return createLiveForm4Adapter(apiKey);
  }
  return createMockForm4Adapter();
}

export async function listAllowlistedDisclosures(
  params?: Form4ListParams,
): Promise<Disclosure[]> {
  const adapter = createForm4Adapter();
  const live = Boolean(process.env.FORM4API_KEY);
  const rows = await adapter.listTransactions({
    perPage: 100,
    ...params,
  });
  // If the live key is set but we had to serve mock rows, label them honestly.
  const usedMock =
    live &&
    rows.length > 0 &&
    rows.every((row) => MOCK_FORM4_TRANSACTIONS.some((mock) => mock.id === row.id));
  const source: Disclosure["source"] = !live || usedMock ? "mock-form4" : "form4";
  return rows.map((row) => enrichDisclosure(row, source));
}

export async function getDisclosureById(id: string): Promise<Disclosure | null> {
  const adapter = createForm4Adapter();
  const live = Boolean(process.env.FORM4API_KEY);
  const row = await adapter.getTransaction(id);
  if (row) {
    const usedMock = MOCK_FORM4_TRANSACTIONS.some((mock) => mock.id === row.id);
    const source: Disclosure["source"] = !live || usedMock ? "mock-form4" : "form4";
    return enrichDisclosure(row, source);
  }
  const { listCongressDisclosures } = await import("@/lib/disclosures/congress");
  const congress = await listCongressDisclosures();
  return congress.find((item) => item.id === id) ?? null;
}
