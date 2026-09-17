import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createServiceSupabase } from "../supabase.ts";

/** The one idempotent createVaultTx draft. `submitted` is latched true BEFORE the create is
 *  broadcast; a discard is refused while it is true. Monotonic in the store: only `clear` resets it. */
export interface CreateDraftTransaction { txBase64: string; messageHash: string; payer: string }
export interface CreateDraftState {
  indexId: string | null;
  draft: { vault: string; mint: string; transactions: CreateDraftTransaction[]; submitted: boolean } | null;
}

/** Read + locked read-modify-write over one draft. Same contract as the file-backed `Journal`,
 *  but durable and shared: it is the only journal the wallet-signed create routes may use. */
export interface CreateDraftStore<S> {
  read(): Promise<S>;
  update<R>(fn: (state: S) => R | Promise<R>): Promise<R>;
}

/** Minimal service-role RPC seam so tests can drive the real SQL without a network. */
export type CreateDraftRpc = (fn: string, args: Record<string, unknown>) => Promise<unknown>;

export function supabaseCreateDraftRpc(db: SupabaseClient): CreateDraftRpc {
  return async (fn, args) => {
    const { data, error } = await db.rpc(fn, args);
    if (error) throw new Error(`Create draft journal ${fn} failed (${error.code ?? "storage"}): ${error.message ?? "unknown"}`);
    return data;
  };
}

/** Service-role Supabase RPC transport (migration 202609190001). Resolved lazily so a missing
 *  service role fails at the operation, not at module import, and always fails closed. */
export function supabaseCreateDraftRpcFromEnv(): CreateDraftRpc {
  return async (fn, args) => {
    const db = createServiceSupabase();
    if (!db) throw new Error("Service-role Supabase is required to read or write the create-draft journal; refusing to create unjournaled.");
    return supabaseCreateDraftRpc(db)(fn, args);
  };
}

function assertDraftKey(key: string): string {
  if (typeof key !== "string" || key.length === 0 || key.length > 128) {
    throw new Error("Create draft key must be 1-128 characters; refusing to journal unjournaled.");
  }
  return key;
}

function parseTransaction(row: unknown): CreateDraftTransaction {
  if (!row || typeof row !== "object") throw new Error("Create draft journal entry is malformed; refusing to resume it.");
  const tx = row as Record<string, unknown>;
  if (typeof tx.txBase64 !== "string" || typeof tx.messageHash !== "string" || typeof tx.payer !== "string") {
    throw new Error("Create draft journal entry is malformed; refusing to resume it.");
  }
  return { txBase64: tx.txBase64, messageHash: tx.messageHash, payer: tx.payer };
}

function stateFromSnapshot(snapshot: unknown, initial: () => CreateDraftState): CreateDraftState {
  if (snapshot === null || snapshot === undefined) return initial();
  if (typeof snapshot !== "object") throw new Error("Create draft journal row is unreadable; refusing to resume it.");
  const row = snapshot as Record<string, unknown>;
  if (row.vault === null || row.vault === undefined) return { ...initial(), indexId: typeof row.indexId === "string" ? row.indexId : initial().indexId };
  if (typeof row.vault !== "string" || typeof row.shareMint !== "string" || !Array.isArray(row.transactions)) {
    throw new Error("Create draft journal row is malformed; refusing to resume it.");
  }
  return {
    indexId: typeof row.indexId === "string" ? row.indexId : null,
    draft: {
      vault: row.vault,
      mint: row.shareMint,
      transactions: row.transactions.map(parseTransaction),
      submitted: row.submitted === true,
    },
  };
}

/** One draft per key, held in the Supabase project the definitions already live in. Preserves every
 *  property of the file journal: one draft per index (primary key), an exclusive writer lease that
 *  fails closed instead of racing, writes fenced on the caller's lease token, and a `submitted`
 *  latch that can only be set true except by `clear`. An unreadable or unwritable journal THROWS,
 *  so the create path refuses rather than ever proceeding unjournaled. */
export class CreateDraftJournal implements CreateDraftStore<CreateDraftState> {
  private readonly key: string;
  private readonly initial: () => CreateDraftState;
  private readonly rpc: CreateDraftRpc;

  constructor(key: string, initial: () => CreateDraftState, rpc: CreateDraftRpc) {
    this.key = assertDraftKey(key);
    this.initial = initial;
    this.rpc = rpc;
  }

  async read(): Promise<CreateDraftState> {
    return stateFromSnapshot(await this.rpc("read_insiderindex_vault_create_draft", { p_draft_key: this.key }), this.initial);
  }

  async update<R>(fn: (state: CreateDraftState) => R | Promise<R>): Promise<R> {
    const token = randomUUID();
    // Take the real lease first. A second concurrent writer fails closed here; it never races.
    const snapshot = await this.rpc("lock_insiderindex_vault_create_draft", { p_draft_key: this.key, p_lock_token: token });
    const state = stateFromSnapshot(snapshot, this.initial);
    let failure: unknown = null;
    try {
      const result = await fn(state);
      if (state.draft) {
        const written = await this.rpc("write_insiderindex_vault_create_draft", {
          p_draft_key: this.key, p_lock_token: token, p_index_id: state.indexId,
          p_vault: state.draft.vault, p_share_mint: state.draft.mint,
          p_transactions: state.draft.transactions, p_submitted: state.draft.submitted,
        });
        // The latch is monotonic in the store: reflect what was actually committed.
        const committed = written as { submitted?: unknown } | null;
        state.draft.submitted = committed?.submitted === true || state.draft.submitted;
      } else {
        await this.rpc("clear_insiderindex_vault_create_draft", { p_draft_key: this.key, p_lock_token: token });
      }
      return result;
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      try {
        await this.rpc("release_insiderindex_vault_create_draft", { p_draft_key: this.key, p_lock_token: token });
      } catch (releaseError) {
        if (!failure) {
          throw new Error(`Create draft journal lease ${token} could not be released (recovery required): ${releaseError instanceof Error ? releaseError.message : String(releaseError)}`);
        }
      }
    }
  }
}

/** Durable journal for one index id. `key` is the index id, so the primary key enforces exactly one
 *  draft per index. No local filesystem is touched. */
export function durableCreateDraftJournal(
  key: string,
  initial: () => CreateDraftState,
  rpc: CreateDraftRpc = supabaseCreateDraftRpcFromEnv(),
): CreateDraftJournal {
  return new CreateDraftJournal(key, initial, rpc);
}

export { assertDraftKey };
