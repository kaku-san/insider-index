import type { AutomationDecision, PolicyValidatedComposition } from "../src/lib/index-vaults/adapter-contract.ts";
import { hashObject, weightsValid } from "../src/lib/index-vaults/amounts.ts";
import { consumePublishedComposition } from "../src/lib/index-vaults/composition.ts";
import type { PublishedComposition } from "../src/lib/index-vaults/composition.ts";

export interface StrategyPolicy {
  indexId: string; policyId: string; policyHash: string; manifestHash: string;
  admitted: { mint: string; oracleAccount: string; tokenProgram: string; decimals: number }[];
  maxTurnoverBps: number; maxWeightChangeBps: number; activationDelaySeconds: number; maxSourceAgeMs: number;
}
/** Deterministic decision only. Separate strategy signing is DISABLED pending native role negative tests. */
export function evaluateComposition(current: PolicyValidatedComposition, published: PublishedComposition, policy: StrategyPolicy, now: number, nativeConflict: boolean): AutomationDecision {
  const result = (decision: AutomationDecision["decision"], reasons: string[]): AutomationDecision => ({ decision, indexId: policy.indexId, policyHash: policy.policyHash, sourceHash: published.composition.sourceDisclosureHash, previousCompositionVersion: current.version, nextCompositionVersion: published.composition.version, reasons, enforcedBy: [{ rule: "source/admission/turnover/delay", strength: "app-policy" }], evidence: [] });
  let next: PolicyValidatedComposition;
  try { next = consumePublishedComposition(published, now, policy.maxSourceAgeMs); weightsValid(current.assets); } catch (error) { return result("BLOCKED", [(error as Error).message]); }
  if (next.indexId !== policy.indexId || current.indexId !== policy.indexId || next.personId !== current.personId || next.policyId !== policy.policyId || next.policyHash !== policy.policyHash || next.manifestHash !== policy.manifestHash) return result("BLOCKED", ["Policy/identity/manifest mismatch"]);
  if (policy.activationDelaySeconds < 300 || !Number.isSafeInteger(policy.activationDelaySeconds) || !Number.isSafeInteger(policy.maxTurnoverBps) || !Number.isSafeInteger(policy.maxWeightChangeBps) || policy.maxTurnoverBps < 0 || policy.maxWeightChangeBps < 0) return result("BLOCKED", ["Invalid signed policy bounds"]);
  if (next.version <= current.version) return result(next.version === current.version && hashObject(next) === hashObject(current) ? "NOOP" : "BLOCKED", ["Already applied or replay/conflicting version"]);
  for (const a of next.assets) {
    if (a.readiness !== "READY" || a.provider === "ondo" || !policy.admitted.some(p => p.mint === a.mint && p.oracleAccount === a.oracle.account && p.tokenProgram === a.tokenProgram && p.decimals === a.decimals)) return result("BLOCKED", ["Unadmitted mint/oracle or failed readiness; deployer admission required"]);
  }
  const all = new Set([...current.assets, ...next.assets].map(a => a.mint));
  const changes = [...all].map(m => Math.abs((next.assets.find(a => a.mint === m)?.targetWeightBps ?? 0) - (current.assets.find(a => a.mint === m)?.targetWeightBps ?? 0)));
  if (changes.every(d => d === 0)) return result("NOOP", ["Unchanged weights; no management transaction"]);
  if (changes.reduce((a, b) => a + b, 0) > policy.maxTurnoverBps * 2 || changes.some(d => d > policy.maxWeightChangeBps)) return result("BLOCKED", ["Turnover or single-weight change exceeds policy"]);
  if (nativeConflict) return result("WAIT", ["Native conflicting intent; preserve active targets"]);
  return result("SUBMIT_WEIGHT_INTENT", ["Policy-valid plan only; native activation delay/read-back and scoped signer release still required"]);
}
