import { isRebalanceRequired } from "@symmetry-hq/sdk";
import type { NativeVaultBuilders } from "../src/lib/index-vaults/symmetry-adapter.ts";
import type { VaultRegistry } from "../src/lib/index-vaults/registry.ts";
import { Journal } from "../src/lib/index-vaults/journal.ts";
import { hashObject } from "../src/lib/index-vaults/amounts.ts";

interface KeeperObservation { vault: string; at: string; configHash: string; next: string; blocked: string[] }
/** Single tick, registered vaults only, persistent exclusive lease. No KeeperMonitor, signer,
 * automatic root access, force mode, swap sender or money-spending loop is installed.
 */
export async function observeKeeperTick(registry: VaultRegistry, native: NativeVaultBuilders, path: string): Promise<KeeperObservation[]> {
  const journal = new Journal<{ observations: KeeperObservation[] }>(path, () => ({ observations: [] }));
  return journal.update(async state => {
    const results: KeeperObservation[] = [];
    for (const entry of await registry.list()) {
      if (entry.identity.network !== native.network) continue;
      const { vault } = await native.read(entry.identity);
      const configHash = hashObject({ fees: (await native.fees(entry.identity)).snapshot, settings: JSON.parse(JSON.stringify(vault.settings)) });
      const previous = [...state.observations].reverse().find(o => o.vault === entry.identity.vaultAccount);
      const blocked = ["BROADCAST_DISABLED", "NATIVE_RELEASE_TESTS_NOT_RUN"];
      if (previous && previous.configHash !== configHash) blocked.push("CONFIG_CHANGED_REATTEST_REQUIRED");
      const intents = await native.sdk.fetchVaultRebalanceIntents(entry.identity.vaultAccount);
      // UI helper is only a task hint. Raw chain fields and exact native fixtures must authorize a builder.
      const next = intents.length ? "RECONCILE_EXISTING_INTENTS" : entry.phase === "RETIRED" ? "RETIRED_EXITS_ONLY" : await isRebalanceRequired(vault, native.connection) ? "NORMAL_REBALANCE_CANDIDATE" : "TARGET_ACTIVE_WAITING";
      results.push({ vault: entry.identity.vaultAccount, at: new Date().toISOString(), configHash, next, blocked });
    }
    state.observations.push(...results); return results;
  });
}
