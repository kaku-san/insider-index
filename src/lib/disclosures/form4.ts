/**
 * Insider (Form 4) lane.
 *
 * Order of preference:
 *  1. SEC EDGAR (`edgar-form4`) — primary, no key, every allowlisted ticker
 *  2. Form4API (`form4`) — fallback only when FORM4API_KEY is set
 *  3. Mock fixtures (`mock-form4`) — dev only (STOCKLANA_ALLOW_MOCKS)
 *
 * Only open-market P/S rows are kept; rows without a ticker are dropped. The
 * issuer set is `edgarUniverse()`; nothing is filtered by tradability — venue
 * is a per-row tag so an insider's book shows every issuer we crawled.
 */

import { edgarUniverse, fetchEdgarTape } from "@/lib/disclosures/edgar";
import { MOCK_FORM4_TRANSACTIONS } from "@/lib/disclosures/mock-form4";
import type {
  Disclosure,
  Form4Adapter,
  Form4ListParams,
  Form4Transaction,
  LaneStatus,
} from "@/lib/disclosures/types";
import { mocksAllowed } from "@/lib/runtime";
import { baseVenueFields } from "@/lib/venues/resolve";

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
  const side = toSide(tx.transactionCode);
  return {
    ...tx,
    source,
    side,
    ...baseVenueFields(tx.ticker, side),
    kind: "insider",
    profileId: `insider-${tx.insiderCik || tx.insiderName.toLowerCase().replace(/\s+/g, "-")}`,
    party: null,
    chamber: null,
    state: null,
    amountLow: tx.transactionValue,
    amountHigh: tx.transactionValue,
  };
}

export function filterTransactions(
  items: Form4Transaction[],
  params: Form4ListParams = {},
): Form4Transaction[] {
  const ticker = params.ticker?.trim().toUpperCase();
  const code = params.code?.trim().toUpperCase();
  const page = params.page ?? 1;
  const perPage = params.perPage ?? 25;
  const allowedCodes = code ? new Set([code]) : new Set(["P", "S"]);

  const filtered = items.filter((item) => {
    if (!item.ticker?.trim()) return false;
    if (ticker && item.ticker.toUpperCase() !== ticker) return false;
    if (!allowedCodes.has(item.transactionCode.toUpperCase())) return false;
    return true;
  });

  filtered.sort(
    (a, b) => +new Date(b.filedAt || b.transactionDate) - +new Date(a.filedAt || a.transactionDate),
  );

  const start = (page - 1) * perPage;
  return filtered.slice(start, start + perPage);
}

// ---------------------------------------------------------------------------
// Mock
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Form4API (fallback)
// ---------------------------------------------------------------------------

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

export function normalizeApiTransaction(
  raw: Form4ApiTransaction,
  index: number,
): Form4Transaction {
  const ticker = (raw.ticker ?? "").toUpperCase();
  const accessionNumber = raw.accessionNumber ?? raw.accession_number ?? `unknown-${index}`;
  const sharesRaw = raw.sharesAmount ?? raw.shares_amount;
  const shares = sharesRaw == null ? null : Number(sharesRaw);
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
    // Zero shares is "not disclosed", never a real print of 0.
    sharesAmount: shares == null || !Number.isFinite(shares) || shares <= 0 ? null : shares,
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
      next: { revalidate: 300 },
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

export function dedupeTransactions(rows: Form4Transaction[]): Form4Transaction[] {
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

async function fetchForm4ApiTape(apiKey: string, params: Form4ListParams): Promise<Form4Transaction[]> {
  const tickers = params.ticker ? [params.ticker.trim().toUpperCase()] : edgarUniverse();
  const batches = await Promise.all(
    tickers.map(async (ticker) => {
      try {
        return await fetchForm4Page(apiKey, { ticker, code: params.code, page: 1, perPage: 25 });
      } catch {
        return [] as Form4Transaction[];
      }
    }),
  );
  return dedupeTransactions(batches.flat());
}

// ---------------------------------------------------------------------------
// Lane orchestration
// ---------------------------------------------------------------------------

export type InsiderTape = {
  rows: Disclosure[];
  status: LaneStatus;
};

function labelRows(rows: Form4Transaction[], source: Disclosure["source"]): Disclosure[] {
  return rows.map((row) => enrichDisclosure(row, source));
}

/**
 * Full insider tape with provenance. EDGAR first; Form4API only if EDGAR
 * yields nothing; mocks only where allowed. Empty tickers are already dropped
 * by filterTransactions.
 */
export async function listInsiderTape(params: Form4ListParams = {}): Promise<InsiderTape> {
  const query: Form4ListParams = { perPage: 500, ...params };
  const notes: string[] = [];

  if (process.env.EDGAR_DISABLED?.trim() === "1") {
    notes.push("EDGAR disabled (EDGAR_DISABLED=1)");
  } else {
    try {
      const tape = await fetchEdgarTape(
        params.ticker ? [params.ticker.trim().toUpperCase()] : edgarUniverse(),
      );
      const rows = filterTransactions(tape.transactions, query);
      const failing = Object.entries(tape.perTicker)
        .filter(([, entry]) => entry.error && entry.cik)
        .map(([ticker]) => ticker);
      if (rows.length > 0) {
        return {
          rows: labelRows(rows, "edgar-form4"),
          status: {
            source: "edgar-form4",
            live: true,
            count: rows.length,
            note: failing.length ? `EDGAR errors for ${failing.join(", ")}` : null,
          },
        };
      }
      notes.push("EDGAR returned no open-market P/S rows");
    } catch (error) {
      notes.push(`EDGAR: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const form4ApiKey = process.env.FORM4API_KEY?.trim();
  if (form4ApiKey) {
    try {
      const rows = filterTransactions(await fetchForm4ApiTape(form4ApiKey, params), query);
      if (rows.length > 0) {
        return {
          rows: labelRows(rows, "form4"),
          status: { source: "form4", live: true, count: rows.length, note: notes.join("; ") || null },
        };
      }
      notes.push("Form4API returned no allowlisted rows");
    } catch (error) {
      notes.push(`Form4API: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (mocksAllowed()) {
    const rows = filterTransactions(MOCK_FORM4_TRANSACTIONS, query);
    return {
      rows: labelRows(rows, "mock-form4"),
      status: {
        source: "mock-form4",
        live: false,
        count: rows.length,
        note: [...notes, "serving labelled fixtures (STOCKLANA_ALLOW_MOCKS)"].join("; "),
      },
    };
  }

  return {
    rows: [],
    status: { source: "off", live: false, count: 0, note: notes.join("; ") || "no insider source available" },
  };
}

export async function listAllowlistedDisclosures(
  params?: Form4ListParams,
): Promise<Disclosure[]> {
  return (await listInsiderTape(params)).rows;
}

export async function getDisclosureById(id: string): Promise<Disclosure | null> {
  const insiders = await listInsiderTape();
  const insider = insiders.rows.find((row) => row.id === id);
  if (insider) return insider;

  if (mocksAllowed()) {
    const mock = await createMockForm4Adapter().getTransaction(id);
    if (mock) return enrichDisclosure(mock, "mock-form4");
  }

  const { listCongressDisclosures } = await import("@/lib/disclosures/congress");
  const congress = await listCongressDisclosures();
  return congress.find((item) => item.id === id) ?? null;
}

/** Legacy factory kept for callers that want the raw adapter surface. */
export function createForm4Adapter(): Form4Adapter {
  return {
    async listTransactions(params = {}) {
      const tape = await listInsiderTape(params);
      return tape.rows;
    },
    async getTransaction(id: string) {
      return getDisclosureById(id);
    },
  };
}
