import "server-only";
import { createServiceSupabase } from "@/lib/supabase";
import { readPublicVaultDefinition, readPublicVaultDefinitions } from "./vault-definition-store";

function store() {
  const db = createServiceSupabase();
  if (!db) throw new Error("vault-definitions-unconfigured");
  return db;
}

export const vaultIndexService = {
  list: async () => readPublicVaultDefinitions(store()),
  get: async (indexId: string) => readPublicVaultDefinition(store(), indexId),
};
