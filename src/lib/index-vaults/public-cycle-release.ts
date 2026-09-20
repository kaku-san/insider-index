import { VAULT_RELEASE } from "./release.ts";
import type { PublicVaultDefinition } from "./vault-definition-store.ts";
import { configuredCyclePolicies } from "./cycle-config.ts";
import { cycleActivationBlockers, type CyclePolicy } from "./cycle-policy-parse.ts";
import { assertPublicCycleScope, PUBLIC_MAG7 } from "./public-cycle-parse.ts";

export type PublicCycleRelease = { publicFundsEnabled: boolean; publicInvestSign: boolean; nativeUsdcExitVerified: boolean };
export function publicCycleReleaseOpen(release: PublicCycleRelease = VAULT_RELEASE): boolean {
  return release.publicFundsEnabled === true && release.publicInvestSign === true;
}
export function publicCyclePolicyActive(policy: CyclePolicy, now = Date.now()): boolean {
  try { assertPublicCycleScope(policy); return cycleActivationBlockers(policy).length === 0 && policy.expiresAt > now; }
  catch { return false; }
}
/** The single configured Mag7 template. Per-wallet depositors are derived from this; they are
 * never a second row in STOCKLANA_CYCLE_POLICIES_JSON. */
export function uniquePublicMag7Policy(env: Record<string, string | undefined> = process.env, now = Date.now()): CyclePolicy {
  const activePolicies = configuredCyclePolicies(env)
    .filter(p => p.indexId === PUBLIC_MAG7.indexId)
    .filter(p => publicCyclePolicyActive(p, now));
  if (!activePolicies.length) throw new Error("CYCLE_PUBLIC_POLICY_UNAVAILABLE");
  if (activePolicies.length !== 1) throw new Error("CYCLE_PUBLIC_AMBIGUOUS_POLICY");
  assertPublicCycleScope(activePolicies[0]);
  return activePolicies[0];
}
/** Availability metadata, not execution authority. Every actual prepare/relay rechecks the
 * persisted definition, keeper, native state, exact policy, history and simulation. */
export function publicCycleIndexEnabled(index: { indexId: string; network?: string | null; vaultAddress?: string | null; shareMint?: string | null; depositsEnabled?: boolean | null }, env: Record<string, string | undefined> = process.env, release: PublicCycleRelease = VAULT_RELEASE): boolean {
  if (!publicCycleReleaseOpen(release) || index.indexId !== PUBLIC_MAG7.indexId || index.network !== "mainnet-beta" || index.vaultAddress !== PUBLIC_MAG7.vault || index.shareMint !== PUBLIC_MAG7.shareMint || index.depositsEnabled !== true) return false;
  try {
    const activePolicies = configuredCyclePolicies(env)
      .filter(p => p.indexId === index.indexId)
      .filter(p => publicCyclePolicyActive(p));
    return activePolicies.length === 1;
  } catch { return false; }
}
export function publicCycleDirectory(indexes: readonly PublicVaultDefinition[], env: Record<string, string | undefined> = process.env, release: PublicCycleRelease = VAULT_RELEASE) {
  return { count: indexes.length, indexes: indexes.map(index => ({ ...index, publicFundsEnabled: publicCycleIndexEnabled(index, env, release) })), publicFundsEnabled: publicCycleReleaseOpen(release), storage: "supabase" };
}
