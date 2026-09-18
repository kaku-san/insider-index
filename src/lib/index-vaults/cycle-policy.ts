import { PublicKey } from "@solana/web3.js";
import { address, hashObject, rawAmount, sdkRawAmount, weightsValid } from "./amounts.ts";
import { discloseNativeCaps } from "./native-caps.ts";
import { legBindings } from "./keeper-tick.ts";
import type { PersistedVaultDefinition } from "./vault-definition-store.ts";

/** Operator-local pilot authority, never a public release toggle. No defaults authorize money.
 * A policy is bound to ONE persisted definition, owner, keeper, operation and deadline. */
export interface CyclePolicy {
  schema: "insiderindex-cycle-policy-v1";
  indexId: string; vault: string; shareMint: string; definitionHash: string;
  owner: string; keeper: string; operationId: string; expiresAt: number;
  approvalReference: string | null;
  feeScheduleHash: string | null;
  financialExecutionAuthorized: boolean;
  economics: {
    keeperSurplus: "unapproved" | "native-filler-retains";
    shareQuantization: "unapproved" | "bounded-native-units";
    residualCash: "unapproved" | "native-backing";
    issuerAuthorityRiskApproved: boolean;
    /** Native mint is permissionless and has no atomic min-share/max-surplus parameter.
     * Client simulation/audit bounds must not be advertised as program-enforced guarantees. */
    nativeSettlementRiskApproved: boolean;
  };
  limits: {
    depositUsdcRaw: string; minNetSharesRaw: string; minExitUsdcRaw: string;
    maxOwnerSolDebitLamports: string; maxKeeperSolDebitLamports: string; maxBountyRaw: string;
    maxRoundingLossUsdcRaw: string; maxKeeperSurplusUsdcRaw: string;
    swapSlippageBps: number; rebalanceSlippageBps: number; perTradeSlippageBps: number;
    maxSettlementDriftBps: number;
    maxComputeUnits: number; maxMicroLamports: string; quoteMaxAgeMs: number;
  };
}
/** Deadlines/references may be explicitly renewed and authorization may be shut off without
 * losing the SAME operation's recovery journal. Identity, economics and money limits stay bound. */
export function cyclePolicyHash(policy: CyclePolicy): string {
  return hashObject({ ...policy, expiresAt: 0, approvalReference: null, financialExecutionAuthorized: false });
}
export function cycleDefinitionHash(record: PersistedVaultDefinition): string {
  return hashObject({ indexId: record.indexId, network: record.network, vault: record.vaultAddress, shareMint: record.shareMint,
    kind: record.kind ?? null, version: record.definitionVersion ?? null,
    legs: record.vaultLegs.map(l => ({ ticker: l.ticker, mint: l.mint, provider: l.provider ?? null, decimals: l.decimals, pool: l.pool, kind: l.kind, targetWeightBps: l.targetWeightBps, tvlUsd: l.tvlUsd?.toString() ?? null })),
    fees: [record.hostEntryFeeBps ?? null, record.hostExitFeeBps ?? null], cap: record.nativeTokenCap ?? null,
    keeper: record.keeper.pubkey });
}
export function assertCycleDefinition(record: PersistedVaultDefinition | null, indexId: string, purpose: "deposit" | "recovery" = "deposit"): PersistedVaultDefinition {
  if (!record || record.indexId !== indexId) throw new Error("CYCLE_DEFINITION_MISSING_OR_SUBSTITUTED");
  if (record.network !== "mainnet-beta" || (purpose === "deposit" && record.status !== "CREATABLE") || !record.vaultAddress || !record.shareMint) throw new Error("CYCLE_UNCREATED_OR_UNREADY");
  address(record.vaultAddress); address(record.shareMint);
  if (purpose === "deposit" && (record.depositsEnabled !== true || record.coverage?.poolReadyOfMappedBps !== 10000 || record.poolExcludedLegs?.length || record.blockedReasons?.length)) throw new Error("CYCLE_PARTIAL_COVERAGE_OR_DEPOSITS_CLOSED");
  if (record.hostEntryFeeBps !== 25 || record.hostExitFeeBps !== 0) throw new Error("CYCLE_FEE_POLICY_CHANGED");
  discloseNativeCaps(record.vaultLegs.length + 2);
  if (!Number.isInteger(record.nativeTokenCap) || record.vaultLegs.length > record.nativeTokenCap! || record.vaultLegs.length < 2) throw new Error("CYCLE_TOKEN_CAP");
  weightsValid(record.vaultLegs);
  legBindings(record.vaultLegs);
  for (const leg of record.vaultLegs) {
    if (!Number.isInteger(leg.decimals) || leg.decimals < 0 || leg.decimals > 18 || (purpose === "deposit" && (!Number.isFinite(leg.tvlUsd) || leg.tvlUsd! < 10_000))) throw new Error(`CYCLE_LEG_UNREADY:${leg.mint}`);
  }
  return record;
}
export function assertCyclePolicy(policy: CyclePolicy, record: PersistedVaultDefinition, now = Date.now(), purpose: "deposit" | "recovery" = "deposit"): void {
  assertCycleDefinition(record, policy.indexId, purpose);
  if (policy.schema !== "insiderindex-cycle-policy-v1" || policy.vault !== record.vaultAddress || policy.shareMint !== record.shareMint || policy.definitionHash !== cycleDefinitionHash(record)) throw new Error("CYCLE_POLICY_IDENTITY_CHANGED");
  address(policy.owner); address(policy.keeper);
  if (policy.owner === policy.keeper || !PublicKey.isOnCurve(new PublicKey(policy.owner).toBytes()) || !PublicKey.isOnCurve(new PublicKey(policy.keeper).toBytes()) || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(policy.operationId)) throw new Error("CYCLE_ROLE_OR_OPERATION");
  if (!Number.isSafeInteger(policy.expiresAt) || policy.expiresAt <= now) throw new Error("CYCLE_AUTHORIZATION_EXPIRED");
  const l = policy.limits;
  for (const key of ["depositUsdcRaw", "minNetSharesRaw", "minExitUsdcRaw", "maxOwnerSolDebitLamports", "maxKeeperSolDebitLamports", "maxBountyRaw", "maxRoundingLossUsdcRaw", "maxKeeperSurplusUsdcRaw", "maxMicroLamports"] as const) rawAmount(l[key], ["depositUsdcRaw", "minNetSharesRaw", "minExitUsdcRaw"].includes(key));
  sdkRawAmount(l.depositUsdcRaw);
  for (const key of ["swapSlippageBps", "rebalanceSlippageBps", "perTradeSlippageBps", "maxSettlementDriftBps"] as const) if (!Number.isInteger(l[key]) || l[key] < 0 || l[key] >= 10000) throw new Error(`CYCLE_INVALID_LIMIT:${key}`);
  if (l.perTradeSlippageBps > l.rebalanceSlippageBps || !Number.isInteger(l.maxComputeUnits) || l.maxComputeUnits < 1 || l.maxComputeUnits > 1_400_000 || !Number.isInteger(l.quoteMaxAgeMs) || l.quoteMaxAgeMs < 1 || l.quoteMaxAgeMs > 60_000) throw new Error("CYCLE_INVALID_EXECUTION_LIMITS");
}
export function cycleActivationBlockers(policy: CyclePolicy): string[] {
  return [
    ...(policy.financialExecutionAuthorized !== true || !policy.approvalReference?.trim() ? ["EXACT_OPERATOR_AUTHORITY_REQUIRED"] : []),
    ...(!policy.feeScheduleHash || !/^[a-f0-9]{64}$/.test(policy.feeScheduleHash) ? ["EXACT_NATIVE_FEE_SCHEDULE_UNAPPROVED"] : []),
    ...(policy.economics.keeperSurplus !== "native-filler-retains" ? ["KEEPER_SURPLUS_POLICY_UNAPPROVED"] : []),
    ...(policy.economics.shareQuantization !== "bounded-native-units" ? ["NATIVE_SHARE_QUANTIZATION_UNAPPROVED"] : []),
    ...(policy.economics.residualCash !== "native-backing" ? ["NATIVE_RESIDUAL_BACKING_UNAPPROVED"] : []),
    ...(policy.economics.issuerAuthorityRiskApproved !== true ? ["ISSUER_FREEZE_PAUSE_DELEGATE_RISK_UNAPPROVED"] : []),
    ...(policy.economics.nativeSettlementRiskApproved !== true ? ["PERMISSIONLESS_NATIVE_SETTLEMENT_LIMITS_UNAPPROVED"] : []),
  ];
}
export function assertCycleExecutionAuthorized(policy: CyclePolicy, record: PersistedVaultDefinition, purpose: "deposit" | "recovery" = "deposit"): void {
  assertCyclePolicy(policy, record, Date.now(), purpose);
  const blockers = cycleActivationBlockers(policy);
  if (blockers.length) throw new Error(`CYCLE_EXECUTION_DISABLED:${blockers.join(",")}`);
  if (purpose === "deposit" && (record.keeper.pubkey !== policy.keeper || record.keeper.automationEnabled !== true)) throw new Error("CYCLE_PERSISTED_KEEPER_AUTHORITY_REQUIRED");
}
export function cycleScope(policy: Pick<CyclePolicy, "indexId" | "vault" | "shareMint" | "owner" | "operationId">): string {
  return hashObject([policy.indexId, policy.vault, policy.shareMint, policy.owner, policy.operationId]);
}
