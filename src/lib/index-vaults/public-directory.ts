import type { PublicVaultDefinition } from "./vault-definition-store.ts";

/** Research metadata alone never authorizes investment. Clients obtain NAV identity and
 * readiness from /api/nav-vault; historical database vault columns are not a signing rail. */
export function publicVaultDirectory(indexes: readonly PublicVaultDefinition[]) {
  return { count: indexes.length, indexes: indexes.map(index => ({ ...index, publicFundsEnabled: false })), publicFundsEnabled: false, storage: "supabase" };
}
