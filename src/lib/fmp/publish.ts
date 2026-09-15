import type { SupabaseClient } from "@supabase/supabase-js";
import { contentHash, type TradeIndexDefinition } from "./trade-index.ts";
import type { HoldingsIndexDefinition } from "./holdings-index.ts";
import { TOP_PROFILE_COUNT, type TopProfilesDocument } from "./top-profiles.ts";

export async function publishHoldingsIndex(db: SupabaseClient, definition: HoldingsIndexDefinition): Promise<string> {
  if (!definition.constituents.length || definition.constituents.reduce((sum, c) => sum + c.weightBps, 0) !== 10_000) throw new Error("Invalid target weights");
  // JSONB/archive reads can reorder object keys. Canonicalize only the derived
  // publication document, never raw FMP bodies or their byte hashes.
  const document = JSON.stringify(definition, (_key, value) => value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, value[key]])) : value);
  const hash = contentHash(JSON.parse(document));
  const { error } = await db.rpc("publish_fmp_holdings_index", { p_hash: hash, p_document: document });
  if (error) throw new Error(`Holdings publication failed (${error.code ?? "storage"}); apply migration 202609140004`);
  return hash;
}

/** Owner RPC publishes the immutable definition and constituents in one transaction.
 * No direct table grants, annual rewrites, or partially visible publications.
 */
export async function publishTradeIndex(db: SupabaseClient, definition: TradeIndexDefinition): Promise<string> {
  if (!definition.constituents.length || definition.constituents.reduce((sum, c) => sum + c.weightBps, 0) !== 10_000) throw new Error("Invalid target weights");
  const document = definition;
  const hash = contentHash(document);
  const { error } = await db.rpc("publish_fmp_trade_index", { p_hash: hash, p_document: JSON.stringify(document) });
  if (error) throw new Error(`Trade publication failed (${error.code ?? "storage"}); ensure the trade-publication migration is applied`);
  return hash;
}

/** Owner RPC replaces the durable top-20 snapshot. Never writes books or invented performance series. */
export async function publishTopProfiles(db: SupabaseClient, document: TopProfilesDocument): Promise<void> {
  if (document.profiles.length > TOP_PROFILE_COUNT) throw new Error("too many profiles");
  const payload = JSON.stringify(document, (_key, value) => value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, value[key]])) : value);
  const { error } = await db.rpc("publish_top_politician_profiles", { p_document: payload });
  if (error) throw new Error(`Top profiles publication failed (${error.code ?? "storage"}); apply migration 202609150003`);
}
