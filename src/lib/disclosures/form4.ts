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
    tradeEligible: Boolean(xstock) && side === "buy",
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

  const filtered = items.filter((item) => {
    if (ticker && item.ticker.toUpperCase() !== ticker) return false;
    if (code && item.transactionCode.toUpperCase() !== code) return false;
    if (!ALLOWLISTED_TICKERS.includes(item.ticker.toUpperCase())) return false;
    return true;
  });

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
    sharesAmount: raw.sharesAmount ?? raw.shares_amount ?? 0,
    pricePerShare: raw.pricePerShare ?? raw.price_per_share ?? null,
    transactionValue: raw.transactionValue ?? raw.transaction_value ?? null,
    sharesOwnedAfter: raw.sharesOwnedAfter ?? raw.shares_owned_after ?? null,
    is10b51: raw.is10b51 ?? raw.is_10b5_1 ?? false,
  };
}

function createLiveForm4Adapter(apiKey: string): Form4Adapter {
  const mock = createMockForm4Adapter();

  return {
    async listTransactions(params = {}) {
      const search = new URLSearchParams();
      search.set("per_page", String(params.perPage ?? 25));
      search.set("page", String(params.page ?? 1));
      search.set("code", params.code ?? "P");
      if (params.ticker) {
        search.set("ticker", params.ticker);
      }

      try {
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
        const normalized = rows.map(normalizeApiTransaction);
        return filterTransactions(normalized, params);
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
  const source = process.env.FORM4API_KEY ? "form4" : "mock-form4";
  const rows = await adapter.listTransactions({
    code: "P",
    perPage: 25,
    ...params,
  });
  return rows.map((row) => enrichDisclosure(row, source));
}

export async function getDisclosureById(id: string): Promise<Disclosure | null> {
  const adapter = createForm4Adapter();
  const source = process.env.FORM4API_KEY ? "form4" : "mock-form4";
  const row = await adapter.getTransaction(id);
  return row ? enrichDisclosure(row, source) : null;
}
