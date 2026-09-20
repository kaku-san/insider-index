import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import type { CycleRpc } from "../../src/lib/index-vaults/cycle-store.ts";
export async function cycleDb() {
  const db = new PGlite();
  await db.exec("create role anon; create role authenticated; create role service_role bypassrls;");
  await db.exec(await readFile(new URL("../../supabase/migrations/202609200001_insiderindex_cycle_operations.sql", import.meta.url), "utf8"));
  await db.exec(await readFile(new URL("../../supabase/migrations/202609200002_insiderindex_cycle_list_vault.sql", import.meta.url), "utf8"));
  await db.exec("set role service_role");
  const rpc: CycleRpc = async (fn, args) => {
    if (!/^(read|lock|write|release|recover)_insiderindex_cycle(_lock)?$|^list_insiderindex_cycles_for_vault$/.test(fn)) throw new Error("Unknown test RPC");
    const values = Object.values(args), result = await db.query(`select ${fn}(${values.map((_, n) => `$${n + 1}`).join(",")}) as value`, values);
    return (result.rows[0] as { value: unknown }).value;
  };
  return { rpc, close: () => db.close(), async asRole(role: "anon" | "authenticated" | "service_role", fn: () => Promise<unknown>) {
    await db.exec(`set role ${role}`); try { return await fn(); } finally { await db.exec("set role service_role"); }
  } };
}
