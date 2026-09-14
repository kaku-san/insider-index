/**
 * Pure parsers for SEC EDGAR Form 4 data. No fetch, no env, no path aliases —
 * this file is unit-tested directly with `node --test`.
 *
 * Inputs:
 *  - data.sec.gov/submissions/CIK##########.json  (recent filings index)
 *  - www.sec.gov/Archives/edgar/data/<cik>/<acc>/<doc>.xml  (ownershipDocument)
 */

import type { Form4Transaction } from "./types";

export type EdgarSubmissions = {
  cik?: string | number;
  name?: string;
  tickers?: string[];
  filings?: {
    recent?: {
      accessionNumber?: string[];
      filingDate?: string[];
      reportDate?: string[];
      acceptanceDateTime?: string[];
      form?: string[];
      primaryDocument?: string[];
    };
  };
};

export type EdgarFilingRef = {
  cik: string;
  accessionNumber: string;
  filingDate: string;
  acceptanceDateTime: string;
  form: string;
  primaryDocument: string;
};

export type ParsedOwner = {
  cik: string;
  name: string;
  title: string | null;
  isDirector: boolean;
  isOfficer: boolean;
  isTenPercentOwner: boolean;
};

export type ParsedTransaction = {
  securityTitle: string;
  transactionDate: string;
  transactionCode: string;
  shares: number | null;
  pricePerShare: number | null;
  acquiredDisposed: "A" | "D" | null;
  sharesOwnedAfter: number | null;
  direct: boolean;
  derivative: boolean;
};

export type ParsedForm4 = {
  documentType: string;
  periodOfReport: string;
  issuerCik: string;
  issuerName: string;
  issuerTicker: string;
  aff10b5One: boolean;
  owners: ParsedOwner[];
  transactions: ParsedTransaction[];
};

export function padCik(cik: string | number): string {
  return String(cik).replace(/\D/g, "").padStart(10, "0");
}

export function stripCik(cik: string | number): string {
  return String(Number(String(cik).replace(/\D/g, "")) || 0);
}

/** `xslF345X06/wk-form4_123.xml` → `wk-form4_123.xml` (raw XML, not the rendered view). */
export function rawPrimaryDocument(primaryDocument: string): string {
  const parts = primaryDocument.split("/");
  return parts[parts.length - 1] ?? primaryDocument;
}

export function edgarDocumentUrl(ref: Pick<EdgarFilingRef, "cik" | "accessionNumber" | "primaryDocument">): string {
  const folder = ref.accessionNumber.replace(/-/g, "");
  return `https://www.sec.gov/Archives/edgar/data/${stripCik(ref.cik)}/${folder}/${rawPrimaryDocument(ref.primaryDocument)}`;
}

export function edgarFilingIndexUrl(ref: Pick<EdgarFilingRef, "cik" | "accessionNumber">): string {
  return `https://www.sec.gov/Archives/edgar/data/${stripCik(ref.cik)}/${ref.accessionNumber.replace(/-/g, "")}/${ref.accessionNumber}-index.htm`;
}

/** Newest-first list of Form 4 (and 4/A) filings from a submissions payload. */
export function selectRecentForm4Filings(
  submissions: EdgarSubmissions,
  limit = 20,
  options: { includeAmendments?: boolean } = {},
): EdgarFilingRef[] {
  const recent = submissions.filings?.recent;
  if (!recent?.form || !recent.accessionNumber) return [];
  const cik = padCik(submissions.cik ?? "0");
  const out: EdgarFilingRef[] = [];
  for (let i = 0; i < recent.form.length && out.length < limit; i += 1) {
    const form = recent.form[i];
    if (form !== "4" && !(options.includeAmendments && form === "4/A")) continue;
    const primaryDocument = recent.primaryDocument?.[i] ?? "";
    if (!primaryDocument.toLowerCase().endsWith(".xml")) continue;
    out.push({
      cik,
      accessionNumber: recent.accessionNumber[i] ?? "",
      filingDate: recent.filingDate?.[i] ?? "",
      acceptanceDateTime: recent.acceptanceDateTime?.[i] ?? "",
      form,
      primaryDocument,
    });
  }
  return out;
}

function decodeEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/&amp;/g, "&");
}

function tagText(block: string, tag: string): string {
  const match = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i").exec(block);
  if (!match) return "";
  let inner = match[1];
  // Most Form 4 fields wrap the actual value in <value>…</value>.
  const value = /<value(?:\s[^>]*)?>([\s\S]*?)<\/value>/i.exec(inner);
  if (value) inner = value[1];
  return decodeEntities(inner.replace(/<[^>]+>/g, "").trim());
}

function tagBlocks(xml: string, tag: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "gi");
  let match: RegExpExecArray | null;
  while ((match = re.exec(xml))) {
    out.push(match[1]);
  }
  return out;
}

function numberOrNull(value: string): number | null {
  if (!value) return null;
  const parsed = Number(value.replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function boolFlag(value: string): boolean {
  const raw = value.trim().toLowerCase();
  return raw === "1" || raw === "true";
}

function parseTransactionBlock(block: string, derivative: boolean): ParsedTransaction {
  const ad = tagText(block, "transactionAcquiredDisposedCode").toUpperCase();
  return {
    securityTitle: tagText(block, "securityTitle"),
    transactionDate: tagText(block, "transactionDate"),
    transactionCode: tagText(block, "transactionCode").toUpperCase(),
    shares: numberOrNull(tagText(block, "transactionShares")),
    pricePerShare: numberOrNull(tagText(block, "transactionPricePerShare")),
    acquiredDisposed: ad === "A" || ad === "D" ? ad : null,
    sharesOwnedAfter: numberOrNull(tagText(block, "sharesOwnedFollowingTransaction")),
    direct: tagText(block, "directOrIndirectOwnership").toUpperCase() !== "I",
    derivative,
  };
}

/** Parse an EDGAR `ownershipDocument` XML string. Tolerates missing sections. */
export function parseForm4Xml(xml: string): ParsedForm4 {
  const owners: ParsedOwner[] = tagBlocks(xml, "reportingOwner").map((block) => {
    const rel = tagBlocks(block, "reportingOwnerRelationship")[0] ?? "";
    return {
      cik: padCik(tagText(block, "rptOwnerCik") || "0"),
      name: tagText(block, "rptOwnerName"),
      title: tagText(rel, "officerTitle") || tagText(rel, "otherText") || null,
      isDirector: boolFlag(tagText(rel, "isDirector")),
      isOfficer: boolFlag(tagText(rel, "isOfficer")),
      isTenPercentOwner: boolFlag(tagText(rel, "isTenPercentOwner")),
    };
  });

  const nonDerivative = tagBlocks(xml, "nonDerivativeTable")
    .flatMap((table) => tagBlocks(table, "nonDerivativeTransaction"))
    .map((block) => parseTransactionBlock(block, false));
  const derivative = tagBlocks(xml, "derivativeTable")
    .flatMap((table) => tagBlocks(table, "derivativeTransaction"))
    .map((block) => parseTransactionBlock(block, true));

  return {
    documentType: tagText(xml, "documentType"),
    periodOfReport: tagText(xml, "periodOfReport"),
    issuerCik: padCik(tagText(xml, "issuerCik") || "0"),
    issuerName: tagText(xml, "issuerName"),
    issuerTicker: tagText(xml, "issuerTradingSymbol").toUpperCase(),
    aff10b5One: boolFlag(tagText(xml, "aff10b5One")),
    owners,
    transactions: [...nonDerivative, ...derivative],
  };
}

export function describeOwner(owner: ParsedOwner): string | null {
  const parts: string[] = [];
  if (owner.title) parts.push(owner.title);
  if (owner.isDirector) parts.push("Director");
  if (owner.isTenPercentOwner) parts.push("10% Owner");
  if (parts.length === 0 && owner.isOfficer) parts.push("Officer");
  return parts.length ? [...new Set(parts)].join(" · ") : null;
}

/**
 * Turn a parsed filing into open-market prints. Only non-derivative code P
 * (purchase) and S (sale) rows are copyable; grants, option exercises, tax
 * withholding, and gifts are skipped so the tape reflects real conviction.
 *
 * By default the lots of one filing are aggregated per (code, trade date) into
 * a single print — a 10b5-1 sale executed in twelve price bands is one
 * decision, not twelve. Price becomes the volume-weighted average.
 */
export function form4ToTransactions(
  parsed: ParsedForm4,
  ref: Pick<EdgarFilingRef, "accessionNumber" | "acceptanceDateTime" | "filingDate">,
  options: { ticker?: string; codes?: readonly string[]; aggregate?: boolean } = {},
): Form4Transaction[] {
  const codes = new Set((options.codes ?? ["P", "S"]).map((code) => code.toUpperCase()));
  const ticker = (options.ticker ?? parsed.issuerTicker).toUpperCase();
  const owner = parsed.owners[0];
  if (!owner || !ticker) return [];

  const filedAt = ref.acceptanceDateTime || (ref.filingDate ? `${ref.filingDate}T00:00:00.000Z` : "");
  const base = {
    accessionNumber: ref.accessionNumber,
    ticker,
    issuerName: parsed.issuerName || ticker,
    insiderName: owner.name || "Unknown insider",
    insiderTitle: describeOwner(owner),
    insiderCik: owner.cik,
    filedAt,
    is10b51: parsed.aff10b5One,
  };

  type Lot = { index: number; tx: ParsedTransaction; shares: number | null; price: number | null };
  const lots: Lot[] = [];
  parsed.transactions.forEach((tx, index) => {
    if (tx.derivative) return;
    if (!codes.has(tx.transactionCode)) return;
    lots.push({
      index,
      tx,
      shares: tx.shares != null && tx.shares > 0 ? tx.shares : null,
      price: tx.pricePerShare != null && tx.pricePerShare > 0 ? tx.pricePerShare : null,
    });
  });

  const groups = new Map<string, Lot[]>();
  for (const lot of lots) {
    const key = options.aggregate === false
      ? String(lot.index)
      : `${lot.tx.transactionCode}|${lot.tx.transactionDate || parsed.periodOfReport}`;
    const bucket = groups.get(key) ?? [];
    bucket.push(lot);
    groups.set(key, bucket);
  }

  const out: Form4Transaction[] = [];
  for (const bucket of groups.values()) {
    const first = bucket[0];
    const last = bucket[bucket.length - 1];
    const priced = bucket.filter((lot) => lot.shares != null && lot.price != null);
    const shares = bucket.some((lot) => lot.shares != null)
      ? bucket.reduce((sum, lot) => sum + (lot.shares ?? 0), 0)
      : null;
    const value = priced.length
      ? Math.round(priced.reduce((sum, lot) => sum + (lot.shares as number) * (lot.price as number), 0) * 100) / 100
      : null;
    const pricedShares = priced.reduce((sum, lot) => sum + (lot.shares as number), 0);
    const price = value != null && pricedShares > 0
      ? Math.round((value / pricedShares) * 10_000) / 10_000
      : bucket.length === 1
        ? first.price
        : null;
    out.push({
      ...base,
      id: `edgar-${ref.accessionNumber}-${first.index}`,
      transactionCode: first.tx.transactionCode,
      transactionDate: first.tx.transactionDate || parsed.periodOfReport,
      sharesAmount: shares != null && shares > 0 ? shares : null,
      pricePerShare: price,
      transactionValue: value != null && value > 0 ? value : null,
      sharesOwnedAfter: last.tx.sharesOwnedAfter,
    });
  }
  return out;
}

export type EdgarTickerRow = { cik_str?: number | string; ticker?: string; title?: string };

/** company_tickers.json is an object keyed by index; map ticker → padded CIK. */
export function buildTickerCikMap(
  payload: Record<string, EdgarTickerRow> | EdgarTickerRow[],
): Map<string, { cik: string; title: string }> {
  const rows = Array.isArray(payload) ? payload : Object.values(payload);
  const map = new Map<string, { cik: string; title: string }>();
  for (const row of rows) {
    const ticker = row.ticker?.toUpperCase().trim();
    if (!ticker || row.cik_str == null) continue;
    map.set(ticker, { cik: padCik(row.cik_str), title: row.title ?? "" });
  }
  return map;
}
