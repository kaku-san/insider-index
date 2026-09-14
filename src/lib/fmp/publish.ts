import type { SupabaseClient } from "@supabase/supabase-js";
import { contentHash, type TradeIndexDefinition } from "./trade-index.ts";

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
