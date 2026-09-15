import type { Vault } from "@symmetry-hq/sdk";
import type { NativeVaultBuilders } from "../src/lib/index-vaults/symmetry-adapter.ts";
import type { VaultIdentity } from "../src/lib/index-vaults/adapter-contract.ts";
import type { VaultRegistry } from "../src/lib/index-vaults/registry.ts";
import { Journal } from "../src/lib/index-vaults/journal.ts";
import { hashObject } from "../src/lib/index-vaults/amounts.ts";
import { feeSnapshot } from "../src/lib/index-vaults/fees.ts";
import { evaluateRebalanceRequired, rebalanceInputFromVault } from "../src/lib/index-vaults/rebalance-eligibility.ts";

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
export const KEEPER_CONFIG_HASH_VERSION = "administrator-config-v1";
export interface KeeperObservation extends KeeperSnapshot {
  at: string; next: string; blocked: string[];
  configHashVersion: typeof KEEPER_CONFIG_HASH_VERSION;
}
type NativeFeeSnapshot = ReturnType<typeof feeSnapshot>;
export function keeperConfigurationHash(vault: Pick<Vault, "settings" | "composition" | "numTokens">, fees: NativeFeeSnapshot): string {
  /* eslint-disable @typescript-eslint/no-unused-vars -- rest destructuring intentionally excludes runtime accounting state */
  const {
    bountyBalance, highWaterMark, activeRebalance, activeWithdraws, activeManagements,
    lastAutomationExecutionTimestamp, managersLastUpdateTimestamp, feesLastUpdateTimestamp,
    scheduleLastUpdateTimestamp, automationLastUpdateTimestamp, lpLastUpdateTimestamp,
    metadataLastUpdateTimestamp, forceRebalanceLastUpdateTimestamp, customRebalanceLastUpdateTimestamp,
    addTokenLastUpdateTimestamp, updateWeightsLastUpdateTimestamp, makeDirectSwapLastUpdateTimestamp,
    creationTimestamp, ...settings
  } = vault.settings;
  const { accruedNativeUnits, representation, ...feeConfiguration } = fees;
  /* eslint-enable @typescript-eslint/no-unused-vars */
  return hashObject({
    fees: feeConfiguration,
    settings: JSON.parse(JSON.stringify(settings)),
    composition: vault.composition.slice(0, vault.numTokens).map(asset => ({
      mint: asset.mint.toBase58(), weight: asset.weight, active: asset.active,
      oracleAggregator: JSON.parse(JSON.stringify(asset.oracleAggregator)),
    })),
  });
}
export function planKeeperObservation(snapshot: KeeperSnapshot, previous?: Pick<KeeperObservation, "configHash"> & Partial<Pick<KeeperObservation, "blocked" | "configHashVersion">>): KeeperObservation {
  const blocked = ["BROADCAST_DISABLED", "NATIVE_RELEASE_TESTS_NOT_RUN"];
  if (previous?.configHashVersion !== undefined
    && (previous.configHashVersion !== KEEPER_CONFIG_HASH_VERSION
      || previous.configHash !== snapshot.configHash
      || previous.blocked?.includes("CONFIG_CHANGED_REATTEST_REQUIRED"))) blocked.push("CONFIG_CHANGED_REATTEST_REQUIRED");
  const next = snapshot.intents.length ? "RECONCILE_EXISTING_INTENTS"
    : snapshot.retired ? "RETIRED_EXITS_ONLY"
    : snapshot.normalRebalanceRequired === true ? "NORMAL_REBALANCE_CANDIDATE"
    : snapshot.normalRebalanceRequired === false ? "TARGET_ACTIVE_WAITING" : "NATIVE_ELIGIBILITY_UNAVAILABLE";
  return { ...snapshot, configHashVersion: KEEPER_CONFIG_HASH_VERSION, at: new Date().toISOString(), next, blocked };
}

/** Read exactly the supplied identity. Caller must supply registry scope or the fixed devnet test identity. */
export async function readKeeperObservation(native: NativeVaultBuilders, identity: VaultIdentity, retired: boolean, previous?: KeeperObservation): Promise<KeeperObservation> {
  const { vault, mint } = await native.read(identity);
  const configHash = keeperConfigurationHash(vault, feeSnapshot(vault, await native.sdk.fetchGlobalConfig()));
  const intents = await native.sdk.fetchVaultRebalanceIntents(identity.vaultAccount);
  const summaries = intents.map(intent => {
    const chain = intent.chain_data;
    if (!chain.ownAddress || chain.vault.toBase58() !== identity.vaultAccount) throw new Error("Native intent address/vault mismatch");
    return { address: chain.ownAddress.toBase58(), owner: chain.owner.toBase58(), type: intent.formatted_data.rebalance_type,
      action: intent.formatted_data.current_action, bountyLeftRaw: chain.bounty.bountyLeft.toString(10) };
  });
  return planKeeperObservation({ vault: identity.vaultAccount, configHash, shareSupplyRaw: mint.supply.toString(), intents: summaries, retired,
    // Quotes stay unloaded here so eligibility never opens Hermes. Price-dependent AND is null until Raydium/JUP quotes are supplied.
    normalRebalanceRequired: intents.length || retired ? null : evaluateRebalanceRequired(rebalanceInputFromVault(vault, Math.floor(Date.now() / 1000), null)).required }, previous);
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
