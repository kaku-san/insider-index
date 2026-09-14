import type { CatalogIndex } from "../venues/catalog-parse.ts";
import type { FmpClient } from "./client.ts";
import type { Batch } from "./types.ts";
import {
  annualSnapshots, mapDisclosedTicker, normalizeActivity, normalizeAggregates,
  normalizePerson, personId, selectIndexInput,
} from "./fmp-parse.ts";

export class PeopleError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) { super(code); this.status = status; this.code = code; }
}
function sourceStatus(batch: Batch) {
  return { status: batch.status, complete: batch.complete, partial: !batch.complete, count: batch.rows.length, pages: batch.pages, issues: batch.issues };
}
function requireSource(batch: Batch): void {
  if (batch.status === "failed") throw new PeopleError(batch.issues.some((i) => i.code === "unconfigured") ? 503 : 502, "fmp-unavailable");
}
/** Wrong/missing IDs cannot turn a successfully fetched array into a complete person's book. */
function scoped(batch: Batch, id: string): Batch {
  const invalid = batch.rows.filter(({ row }) => personId(row.senateID) !== id);
  if (!invalid.length) return batch;
  return {
    ...batch, complete: false, status: "partial",
    issues: [...batch.issues, { code: "identity", endpoint: batch.endpoint, page: invalid[0].source.params.page ?? 0 }],
  };
}

export function createPeopleService(client: FmpClient, loadCatalog: () => Promise<CatalogIndex & {
  feeds?: readonly { issuer: string; source: string; fetchedAt: string }[];
}>) {
  return {
    async directory() {
      const batch = await client.profiles();
      requireSource(batch);
      const people = new Map<string, NonNullable<ReturnType<typeof normalizePerson>>>();
      let unnormalizedCount = 0;
      for (const { row } of batch.rows) {
        const person = normalizePerson(row);
        if (person) people.set(person.id, person);
        else unnormalizedCount++;
      }
      const complete = batch.complete && unnormalizedCount === 0;
      return {
        source: "fmp" as const, people: [...people.values()].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)),
        complete, partial: !complete, unnormalizedCount, ingestion: sourceStatus(batch),
        coverage: "provider-directory; a profile does not imply an annual book or investable index",
      };
    },
    async portfolio(id: string, options: { holdingsOnly?: boolean } = {}) {
      if (!personId(id)) throw new PeopleError(400, "invalid-person-id");
      const profileBatch = scoped(await client.profiles(id), id);
      requireSource(profileBatch);
      const person = profileBatch.rows.map(({ row }) => normalizePerson(row)).find((p) => p?.id === id);
      if (!person) {
        const notFound = profileBatch.complete && profileBatch.rows.length === 0;
        throw new PeopleError(notFound ? 404 : 502, notFound ? "person-not-found" : "fmp-incomplete-profile");
      }
      // Holdings ingestion must not wait for (or request) optional trade histories.
      const skipped = (endpoint: Batch["endpoint"]): Batch => ({ endpoint, status: "not-requested", complete: false, rows: [], pages: [], issues: [] });
      const [annualRaw, aggregateRaw, houseRaw, senateRaw, catalog] = await Promise.all([
        client.annual(id),
        options.holdingsOnly ? skipped("senate-net-worth-aggregated") : client.aggregates(id),
        options.holdingsOnly ? skipped("house-trades-by-id") : client.houseTrades(id),
        options.holdingsOnly ? skipped("senate-trades-by-id") : client.senateTrades(id), loadCatalog(),
      ]);
      const annual = scoped(annualRaw, id), aggregates = scoped(aggregateRaw, id);
      const house = scoped(houseRaw, id), senate = scoped(senateRaw, id);
      const snapshots = annualSnapshots(annual, id);
      const input = selectIndexInput(snapshots, catalog);
      const activity = [...house.rows, ...senate.rows].map(normalizeActivity)
        .sort((a, b) => (b.disclosureDate ?? "").localeCompare(a.disclosureDate ?? "") || a.id.localeCompare(b.id));
      const activityComplete = house.complete && senate.complete && activity.every((a) => a.transactionDate && a.disclosureDate && a.name && a.event);
      const annualAggregates = normalizeAggregates(aggregates);
      const aggregatesComplete = aggregates.complete && annualAggregates.every((a) => a.year !== null);
      const complete = profileBatch.complete && annual.complete && aggregatesComplete && activityComplete && snapshots.every((s) => s.complete);
      return {
        source: "fmp" as const, person, complete, partial: !complete,
        bookComplete: snapshots.length > 0 && snapshots.every((s) => s.complete),
        state: annual.status === "failed" ? "annual-source-unavailable" : !annual.rows.length ? (activity.length ? "activity-only" : "no-annual-book") : input.snapshotId ? "annual-input" : "partial-disclosure-only",
        catalog: { feeds: catalog.feeds ?? [], observedMintCount: catalog.size },
        snapshots: snapshots.map((s) => ({ ...s, items: s.items.map((item) => mapDisclosedTicker(item, catalog)) })),
        indexInput: input,
        activity: activity.map((item) => ({
          ...mapDisclosedTicker(item, catalog),
          sinceReport: input.referenceDate && item.transactionDate ? item.transactionDate > input.referenceDate : null,
        })),
        activityComplete,
        annualAggregates,
        aggregatesComplete,
        ingestion: {
          profile: sourceStatus(profileBatch), annual: sourceStatus(annual), aggregates: sourceStatus(aggregates),
          houseActivity: sourceStatus(house), senateActivity: sourceStatus(senate),
        },
        // No publication, weights, current holdings, executable basket or performance claim.
        methodology: "Latest complete annual equity/ETF source input only. PTRs remain activity; aggregates are unreconciled provider estimates. Catalog availability is not execution approval.",
      };
    },
  };
}
export type PeopleService = ReturnType<typeof createPeopleService>;
