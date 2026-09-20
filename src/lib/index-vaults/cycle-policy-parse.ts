import { hashObject } from "./amounts.ts";
import type { PersistedVaultDefinition } from "./vault-definition-store.ts";

/** Operator-local authority, not a public release toggle. No default authorizes money. */
export interface CyclePolicy {
  schema: "insiderindex-cycle-policy-v1";
  indexId: string; vault: string; shareMint: string; definitionHash: string;
  owner: string; keeper: string; operationId: string; expiresAt: number;
  /** Finalized chain anchor for independently auditing this operation's owner history. */
  notBeforeSlot: number;
  approvalReference: string | null; feeScheduleHash: string | null;
  financialExecutionAuthorized: boolean;
  economics: {
    keeperSurplus: "unapproved" | "native-filler-retains";
    shareQuantization: "unapproved" | "bounded-native-units";
    residualCash: "unapproved" | "native-backing";
    issuerAuthorityRiskApproved: boolean;
    /** Permissionless native mint lacks an atomic min-share/max-surplus parameter.
     * Client simulation/audit is not a program-enforced financial guarantee. */
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
/** Closing new deposits must not turn an exit, claim or cancellation into new funding. */
export function cycleActionPurpose(action: string): "deposit" | "recovery" {
  return ["withdraw", "claim", "convert", "cancel", "cleanup"].includes(action) ? "recovery" : "deposit";
}
/** Renewing deadlines/references or shutting off execution must not erase recovery history. */
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
export function cycleScope(policy: Pick<CyclePolicy, "indexId" | "vault" | "shareMint" | "owner" | "operationId">): string {
  return hashObject([policy.indexId, policy.vault, policy.shareMint, policy.owner, policy.operationId]);
}
