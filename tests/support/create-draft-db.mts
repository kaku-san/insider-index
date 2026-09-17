import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import type { CreateDraftRpc } from "../../src/lib/index-vaults/create-draft-store.ts";

/** A service-role `CreateDraftRpc` backed by the REAL create-draft migration in PGlite.
 *  Tests drive the actual SQL (row lock, monotonic latch, token fence), not a hand-written model
 *  of it, so a behaviour asserted here is a behaviour of the migration the operator applies. */
export interface CreateDraftDb {
  rpc: CreateDraftRpc;
  query<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<R[]>;
  close(): Promise<void>;
}

export async function createDraftDb(): Promise<CreateDraftDb> {
  const db = new PGlite();
  await db.exec("create role anon; create role authenticated; create role service_role bypassrls;");
  await db.exec(await readFile(new URL("../../supabase/migrations/202609190001_insiderindex_vault_create_drafts.sql", import.meta.url), "utf8"));
  await db.exec("set role service_role");
  return {
    rpc: async (fn, args) => {
      const names = Object.keys(args);
      const { rows } = await db.query(`select ${fn}(${names.map((_, i) => `$${i + 1}`).join(",")}) as result`, names.map(name => args[name]));
      return (rows[0] as { result?: unknown } | undefined)?.result ?? null;
    },
    query: async <R = Record<string, unknown>,>(sql: string, params: unknown[] = []) => (await db.query<R>(sql, params)).rows,    close: () => db.close(),
  };
}
