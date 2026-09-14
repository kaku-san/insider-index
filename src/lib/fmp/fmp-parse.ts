/** Pure normalization: no env/fetch/aliases, and no inferred holdings from PTR dollar bands. */
import { parseTradeSize } from "../disclosures/ainvest-parse.ts";
import { preferredToken, normalizeTicker, type CatalogIndex } from "../venues/catalog-parse.ts";
import type { Activity, Band, Batch, DisclosedItem, FmpRow, ItemKind, Person, Snapshot, SourceRow } from "./types.ts";

export function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
export function personId(value: unknown): string | null {
  const id = text(value);
  return id && /^[A-Z]\d{6}$/.test(id) ? id : null;
}
function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function year(value: unknown): number | null {
  const n = number(value);
  return n !== null && Number.isInteger(n) && n >= 1900 && n <= 2200 ? n : null;
}
function date(value: unknown): string | null {
  const s = text(value);
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const parsed = new Date(s);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === s ? s : null;
}
function url(value: unknown): string | null {
  const s = text(value);
  if (!s) return null;
  try {
    const u = new URL(s);
    return u.protocol === "https:" && !u.username && !u.password ? s : null;
  } catch { return null; }
}
function band(value: unknown): Band {
  const r = value && typeof value === "object" ? value as FmpRow : {};
  return { low: number(r.min), high: number(r.max) };
}
function ticker(row: FmpRow): string | null {
  // Annual FMP names can contain apparent tickers, but those are not reviewed security IDs.
  // Only dedicated symbols are accepted here. Missing/ambiguous names remain disclosed-only.
  const s = text(row.symbol) ?? text(row.ticker);
  return s && /^[A-Za-z][A-Za-z0-9./-]{0,14}$/.test(s) && !/^(N\/A|NONE|UNKNOWN)$/i.test(s) ? normalizeTicker(s) : null;
}
export function normalizePerson(row: FmpRow): Person | null {
  const id = personId(row.senateID);
  const firstName = text(row.firstName), lastName = text(row.lastName);
  if (!id || (!firstName && !lastName)) return null;
  const position = text(row.latestPosition);
  return {
    id, provider: "fmp", providerId: id, name: [firstName, lastName].filter(Boolean).join(" "),
    firstName, lastName, position,
    chamber: /representative/i.test(position ?? "") ? "house" : /senator/i.test(position ?? "") ? "senate" : "unknown",
    party: text(row.latestParty), state: text(row.latestState),
    active: typeof row.active === "boolean" ? row.active : null, image: url(row.image),
  };
}
export function itemKind(row: FmpRow): ItemKind {
  const section = text(row.section) ?? "";
  if (/^income$/i.test(section)) return "income";
  if (/^liabilit/i.test(section)) return "liability";
  const type = text(row.assetType) ?? "";
  const name = text(row.name) ?? text(row.assetDescription) ?? "";
  // Instrument precedes underlying ticker: an AAPL option or corporate bond is not stock.
  if (/option|\b(call|put)\b/i.test(type) || /\[OP\]|\b(call|put) options?\b/i.test(name)) return "option";
  if (/^(ETF|Exchange.Traded Fund)$/i.test(type) || (!type && /\[EF\]/.test(name))) return "etf";
  if (/^(Stock|Common Stock)$/i.test(type) || (!type && /\[ST\]/.test(name))) return "stock";
  return "other";
}
function rowId(record: SourceRow): string {
  return `${record.source.endpoint}:${record.source.payloadHash}:${record.source.params.page ?? 0}:${record.ordinal}`;
}
export function normalizeAnnual(record: SourceRow, expectedPerson: string): DisclosedItem {
  const r = record.row;
  const y = year(r.year);
  return {
    id: rowId(record), personId: personId(r.senateID) ?? expectedPerson,
    year: y, referenceDate: y === null ? null : `${y}-12-31`, filingDate: date(r.filingDate), availableAt: null,
    name: text(r.name), ticker: ticker(r), kind: itemKind(r), section: text(r.section), category: text(r.category),
    assetType: text(r.assetType), formType: text(r.formType), owner: text(r.owner), comment: text(r.comment),
    debtDetails: r.debtDetails ?? null, valueRange: band(r.valueRange), providerValue: number(r.value),
    incomeRange: band(r.incomeRange), providerIncome: number(r.income), incomeType: text(r.incomeType),
    sourceUrl: url(r.link), source: record.source, ordinal: record.ordinal,
  };
}
export function normalizeActivity(record: SourceRow): Activity {
  const r = record.row;
  const amountLabel = text(r.amount);
  return {
    id: rowId(record), personId: personId(r.senateID), name: text(r.assetDescription), ticker: ticker(r),
    kind: itemKind(r), owner: text(r.owner), transactionDate: date(r.transactionDate),
    disclosureDate: date(r.disclosureDate), event: text(r.type), amount: parseTradeSize(amountLabel), amountLabel,
    assetType: text(r.assetType), comment: text(r.comment), sourceUrl: url(r.link), source: record.source, ordinal: record.ordinal,
  };
}

/** A catalog tag is availability, NOT permission to buy or proof of contract support. */
export function mapDisclosedTicker<T extends { ticker: string | null; kind: ItemKind }>(item: T, catalog: CatalogIndex) {
  const eligibleInstrument = item.kind === "stock" || item.kind === "etf";
  const token = eligibleInstrument && item.ticker ? preferredToken(catalog, item.ticker) : null;
  return {
    ...item,
    token: token ? { issuer: token.issuer, symbol: token.symbol, mint: token.mint, decimals: token.decimals, chain: "solana" as const } : null,
    disclosureOnly: !token,
    mappingReason: !eligibleInstrument ? "ineligible-instrument" : !item.ticker ? "unresolved-security" : !token ? "no-solana-mint" : null,
  };
}

export function annualSnapshots(batch: Batch, expectedPerson: string): Snapshot[] {
  const groups = new Map<string, DisclosedItem[]>();
  for (const record of batch.rows) {
    const item = normalizeAnnual(record, expectedPerson);
    const identity = JSON.stringify([item.personId, item.year, item.filingDate, item.sourceUrl, item.formType]);
    const items = groups.get(identity) ?? [];
    items.push(item); // Ordinals preserve legitimate duplicate rows and separate household accounts.
    groups.set(identity, items);
  }
  const snapshots: Snapshot[] = [];
  for (const [identity, items] of groups) {
    const first = items[0];
    const issues: string[] = [];
    if (!batch.complete) issues.push("partial-ingestion");
    if (first.personId !== expectedPerson) issues.push("person-mismatch");
    if (items.some((i) => !i.year || !i.filingDate || !i.sourceUrl || !i.name || !i.section || !i.formType)) issues.push("incomplete-document-metadata");
    if (items.some((i) => !/^(House Report|Senate Report|Annual Report)$/i.test(i.formType ?? ""))) issues.push("unreconciled-report-type");
    if (items.some((i) => !/^(Asset|Assets|Income|Liabilities)$/i.test(i.section ?? ""))) issues.push("unknown-section");
    // Multiple documents for one period may be partial amendments, not full replacements.
    if ([...groups.values()].filter((g) => g[0].year === first.year && g[0].personId === first.personId).length > 1) issues.push("unreconciled-versions");
    const kind = (k: ItemKind) => items.filter((i) => i.kind === k);
    snapshots.push({
      id: `fmp-snapshot:${encodeURIComponent(identity)}:${[...new Set(items.map((i) => i.source.payloadHash))].sort().join(".")}`, personId: first.personId, year: first.year,
      referenceDate: first.referenceDate, filingDate: first.filingDate, sourceUrl: first.sourceUrl,
      complete: issues.length === 0, partial: issues.length > 0, issues, items,
      stocks: kind("stock"), etfs: kind("etf"), options: kind("option"), income: kind("income"), liabilities: kind("liability"), other: kind("other"),
    });
  }
  return snapshots.sort((a, b) => (b.year ?? 0) - (a.year ?? 0) || (b.filingDate ?? "").localeCompare(a.filingDate ?? "") || a.id.localeCompare(b.id));
}

/** Annual source only. No activity argument, so PTRs cannot mutate this index input. */
export function selectIndexInput(snapshots: readonly Snapshot[], catalog: CatalogIndex) {
  const selected = snapshots.find((s) => s.complete);
  if (!selected) return { snapshotId: null, year: null, referenceDate: null, items: [], status: "unavailable" as const };
  return {
    snapshotId: selected.id, year: selected.year, referenceDate: selected.referenceDate,
    items: [...selected.stocks, ...selected.etfs].map((item) => mapDisclosedTicker(item, catalog)),
    status: "annual-input-only" as const,
  };
}

/** Provider estimates are not a reconciled net-worth total; keep the original category series. */
export function normalizeAggregates(batch: Batch) {
  return batch.rows.map(({ row, source, ordinal }) => ({
    personId: personId(row.senateID), year: year(row.year),
    providerEstimates: Object.fromEntries(Object.entries(row).filter(([key]) => key !== "senateID" && key !== "year").map(([key, value]) => [key, number(value)])),
    reconciled: false as const, source, ordinal,
  }));
}
