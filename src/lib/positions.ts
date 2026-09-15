import { createServiceSupabase } from "./supabase.ts";
import { globalState } from "./cache.ts";
import { isProduction } from "./runtime.ts";
import { positionFromRow, positionToRow, type PositionRow, type TrackedPosition } from "./position-contract.ts";
export type { TrackedPosition } from "./position-contract.ts";

export class PositionStoreError extends Error {
  constructor() { super("Copy receipt storage unavailable. Supabase service role and the copy storage migrations are required."); }
}

export function positionClient() {
  const client = createServiceSupabase();
  if (!client && isProduction()) throw new PositionStoreError();
  return client;
}
const memory = () => globalState("copy_positions", () => new Map<string, TrackedPosition>());

/** Check the actual table before sending a signed transaction upstream. */
export async function assertPositionStoreReady(): Promise<void> {
  const client = positionClient();
  if (!client) return;
  const { error: positionsError } = await client.from("positions").select("id").limit(1);
  const { error: ordersError } = await client.from("copy_orders").select("request_id").limit(1);
  const { error: pruneError } = await client.rpc("prune_expired_copy_orders");
  if (positionsError || ordersError || pruneError) throw new PositionStoreError();
}

export async function listPositions(wallet: string): Promise<TrackedPosition[]> {
  const client = positionClient();
  if (!client) return [...memory().values()].filter(p => p.wallet === wallet).reverse();
  const { data, error } = await client.from("positions").select("*").eq("wallet", wallet).order("created_at", { ascending: false }).limit(100);
  if (error || !data) throw new PositionStoreError();
  return (data as PositionRow[]).map(positionFromRow);
}

export async function recordPosition(position: Omit<TrackedPosition, "id" | "createdAt">): Promise<TrackedPosition> {
  if (isProduction() && position.stub) throw new PositionStoreError();
  const row = { ...position, id: crypto.randomUUID(), createdAt: new Date().toISOString() };
  const client = positionClient();
  if (!client) {
    const previous = memory().get(position.requestId);
    if (previous) return previous;
    memory().set(position.requestId, row);
    return row;
  }
  // Replayed Jupiter responses must not multiply receipts or overwrite the original fill.
  const { error } = await client.from("positions").upsert(positionToRow(row), { onConflict: "request_id", ignoreDuplicates: true });
  if (error) throw new PositionStoreError();
  const { data, error: readError } = await client.from("positions").select("*").eq("request_id", position.requestId).single();
  if (readError || !data) throw new PositionStoreError();
  return positionFromRow(data as PositionRow);
}
