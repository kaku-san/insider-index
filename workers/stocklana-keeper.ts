import { isRebalanceRequired } from "@symmetry-hq/sdk";
import type { NativeVaultBuilders } from "../src/lib/index-vaults/symmetry-adapter.ts";
import type { VaultIdentity } from "../src/lib/index-vaults/adapter-contract.ts";
import type { VaultRegistry } from "../src/lib/index-vaults/registry.ts";
import { Journal } from "../src/lib/index-vaults/journal.ts";
import { hashObject } from "../src/lib/index-vaults/amounts.ts";

export interface KeeperIntentObservation {
  address: string; owner: string; type: string; action: string;
  bountyLeftRaw: string;
}
export interface KeeperSnapshot {
  vault: string; configHash: string; shareSupplyRaw: string;
  intents: KeeperIntentObservation[];
  retired: boolean;
  // Native SDK helper is a hint, not a verified execution predicate. Null when intents take priority.
  normalRebalanceRequired: boolean | null;
}
export interface KeeperObservation extends KeeperSnapshot {
  at: string; next: string; blocked: string[];
}
export function planKeeperObservation(snapshot: KeeperSnapshot, previous?: Pick<KeeperObservation, "configHash"> & { blocked?: string[] }): KeeperObservation {
  const blocked = ["BROADCAST_DISABLED", "NATIVE_RELEASE_TESTS_NOT_RUN"];
  if (previous && (previous.configHash !== snapshot.configHash || previous.blocked?.includes("CONFIG_CHANGED_REATTEST_REQUIRED"))) blocked.push("CONFIG_CHANGED_REATTEST_REQUIRED");
  const next = snapshot.intents.length ? "RECONCILE_EXISTING_INTENTS"
    : snapshot.retired ? "RETIRED_EXITS_ONLY"
    : snapshot.normalRebalanceRequired === true ? "NORMAL_REBALANCE_CANDIDATE"
    : snapshot.normalRebalanceRequired === false ? "TARGET_ACTIVE_WAITING" : "NATIVE_ELIGIBILITY_UNAVAILABLE";
  return { ...snapshot, at: new Date().toISOString(), next, blocked };
}

/** Read exactly the supplied identity. Caller must supply registry scope or the fixed devnet test identity. */
export async function readKeeperObservation(native: NativeVaultBuilders, identity: VaultIdentity, retired: boolean, previous?: KeeperObservation): Promise<KeeperObservation> {
  const { vault, mint } = await native.read(identity);
  const configHash = hashObject({ fees: (await native.fees(identity)).snapshot, settings: JSON.parse(JSON.stringify(vault.settings)), composition: vault.composition.slice(0, vault.numTokens).map(a => ({ mint: a.mint.toBase58(), weight: a.weight, active: a.active, oracleAggregator: JSON.parse(JSON.stringify(a.oracleAggregator)) })) });
  const intents = await native.sdk.fetchVaultRebalanceIntents(identity.vaultAccount);
  const summaries = intents.map(intent => {
    const chain = intent.chain_data;
    if (!chain.ownAddress || chain.vault.toBase58() !== identity.vaultAccount) throw new Error("Native intent address/vault mismatch");
    return { address: chain.ownAddress.toBase58(), owner: chain.owner.toBase58(), type: intent.formatted_data.rebalance_type,
      action: intent.formatted_data.current_action, bountyLeftRaw: chain.bounty.bountyLeft.toString(10) };
  });
  return planKeeperObservation({ vault: identity.vaultAccount, configHash, shareSupplyRaw: mint.supply.toString(), intents: summaries, retired,
    normalRebalanceRequired: intents.length || retired ? null : await isRebalanceRequired(vault, native.connection) }, previous);
}

/** Single tick, registered vaults only, persistent exclusive lease. No KeeperMonitor, signer,
 * automatic root access, force mode, swap sender or money-spending loop is installed.
 */
export async function observeKeeperTick(registry: VaultRegistry, native: NativeVaultBuilders, path: string): Promise<KeeperObservation[]> {
  const journal = new Journal<{ observations: KeeperObservation[] }>(path, () => ({ observations: [] }));
  return journal.update(async state => {
    const results: KeeperObservation[] = [];
    for (const entry of await registry.list()) {
      if (entry.identity.network !== native.network) continue;
      const previous = [...state.observations].reverse().find(o => o.vault === entry.identity.vaultAccount);
      results.push(await readKeeperObservation(native, entry.identity, entry.phase === "RETIRED", previous));
    }
    state.observations.push(...results); return results;
  });
}
