import type { SupabaseClient } from "@supabase/supabase-js";
import type { RawCapture } from "./client.ts";
import type { StoredPortfolio } from "./store.ts";
import { contentHash } from "./trade-index.ts";

/** Capture exact redacted bytes before the existing owner RPC saves normalized views. */
export function supabaseArchive(db: SupabaseClient) {
  return async (capture: RawCapture) => {
    const { error } = await db.from("raw_batches").insert({
      id: contentHash(capture), endpoint: capture.endpoint, params: capture.params,
      fetched_at: capture.fetchedAt, payload_hash: capture.payloadHash,
      row_count: capture.rowCount, http_status: capture.httpStatus, body: capture.body,
    });
    if (error) throw new Error("raw-archive-unavailable");
  };
}
export async function saveHoldings(db: SupabaseClient, portfolio: StoredPortfolio, previous: StoredPortfolio | null) {
  // A holdings-only run cannot erase histories already saved by a later optional trade job.
  const saved = previous ? {
    ...portfolio, activity: previous.activity, activityComplete: previous.activityComplete,
    annualAggregates: previous.annualAggregates, aggregatesComplete: previous.aggregatesComplete,
    ingestion: { ...portfolio.ingestion, houseActivity: previous.ingestion.houseActivity,
      senateActivity: previous.ingestion.senateActivity, aggregates: previous.ingestion.aggregates },
  } : portfolio;
  const { error } = await db.rpc("save_fmp_portfolio", {
    p_portfolio: saved,
    p_snapshots: portfolio.snapshots.map((payload) => ({ id: contentHash(payload), payload })),
  });
  if (error) throw new Error(`holdings-save-failed (${error.code ?? "storage"})`);
}
