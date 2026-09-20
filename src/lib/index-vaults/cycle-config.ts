import { PublicKey } from "@solana/web3.js";
import { rawAmount } from "./amounts.ts";
import type { CyclePolicy } from "./cycle-policy-parse.ts";

function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some(k => !(k in value))) throw new Error("CYCLE_CONFIG_SHAPE");
  return value as Record<string, unknown>;
}
/** Exact operator configuration, not request-supplied spending authority. Missing fields never
 * acquire permissive defaults. Expired/disabled policies remain readable for reconciliation. */
export function parseCyclePolicy(value: unknown): CyclePolicy {
  const p = object(value, ["schema", "indexId", "vault", "shareMint", "definitionHash", "owner", "keeper", "operationId", "expiresAt", "notBeforeSlot", "approvalReference", "feeScheduleHash", "financialExecutionAuthorized", "economics", "limits"]);
  if (p.schema !== "insiderindex-cycle-policy-v1" || typeof p.indexId !== "string" || !/^idx-[a-z0-9-]{1,120}$/.test(p.indexId) || typeof p.operationId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(p.operationId)) throw new Error("CYCLE_CONFIG_IDENTITY");
  for (const key of ["vault", "shareMint", "owner", "keeper"] as const) {
    if (typeof p[key] !== "string") throw new Error("CYCLE_CONFIG_ADDRESS");
    const address = new PublicKey(p[key]);
    if (address.toBase58() !== p[key] || (["owner", "keeper"].includes(key) && !PublicKey.isOnCurve(address.toBytes()))) throw new Error("CYCLE_CONFIG_ADDRESS");
  }
  if (p.owner === p.keeper || typeof p.definitionHash !== "string" || !/^[a-f0-9]{64}$/.test(p.definitionHash) || (p.feeScheduleHash !== null && (typeof p.feeScheduleHash !== "string" || !/^[a-f0-9]{64}$/.test(p.feeScheduleHash)))) throw new Error("CYCLE_CONFIG_BINDING");
  if (typeof p.financialExecutionAuthorized !== "boolean" || (p.approvalReference !== null && (typeof p.approvalReference !== "string" || !p.approvalReference.trim() || p.approvalReference.length > 500)) || !Number.isSafeInteger(p.expiresAt) || Number(p.expiresAt) <= 0 || !Number.isSafeInteger(p.notBeforeSlot) || Number(p.notBeforeSlot) <= 0) throw new Error("CYCLE_CONFIG_AUTHORITY");
  const e = object(p.economics, ["keeperSurplus", "shareQuantization", "residualCash", "issuerAuthorityRiskApproved", "nativeSettlementRiskApproved"]);
  for (const [key, approved] of [["keeperSurplus", "native-filler-retains"], ["shareQuantization", "bounded-native-units"], ["residualCash", "native-backing"]]) if (e[key] !== "unapproved" && e[key] !== approved) throw new Error("CYCLE_CONFIG_ECONOMICS");
  if (typeof e.issuerAuthorityRiskApproved !== "boolean" || typeof e.nativeSettlementRiskApproved !== "boolean") throw new Error("CYCLE_CONFIG_ECONOMICS");
  const amounts = ["depositUsdcRaw", "minNetSharesRaw", "minExitUsdcRaw", "maxOwnerSolDebitLamports", "maxKeeperSolDebitLamports", "maxBountyRaw", "maxRoundingLossUsdcRaw", "maxKeeperSurplusUsdcRaw", "maxMicroLamports"];
  const bps = ["swapSlippageBps", "rebalanceSlippageBps", "perTradeSlippageBps", "maxSettlementDriftBps"];
  const l = object(p.limits, [...amounts, ...bps, "maxComputeUnits", "quoteMaxAgeMs"]);
  for (const key of amounts) {
    if (typeof l[key] !== "string") throw new Error("CYCLE_CONFIG_RAW_AMOUNT");
    rawAmount(l[key], ["depositUsdcRaw", "minNetSharesRaw", "minExitUsdcRaw"].includes(key));
  }
  for (const key of bps) if (!Number.isInteger(l[key]) || Number(l[key]) < 0 || Number(l[key]) >= 10000) throw new Error("CYCLE_CONFIG_BPS");
  if (Number(l.perTradeSlippageBps) > Number(l.rebalanceSlippageBps) || !Number.isInteger(l.maxComputeUnits) || Number(l.maxComputeUnits) < 1 || Number(l.maxComputeUnits) > 1400000 || !Number.isInteger(l.quoteMaxAgeMs) || Number(l.quoteMaxAgeMs) < 1 || Number(l.quoteMaxAgeMs) > 60000) throw new Error("CYCLE_CONFIG_EXECUTION_LIMIT");
  return structuredClone(value) as CyclePolicy;
}
export function configuredCyclePolicies(env: Record<string, string | undefined> = process.env): CyclePolicy[] {
  const encoded = env.STOCKLANA_CYCLE_POLICIES_JSON;
  if (!encoded) return [];
  let rows: unknown; try { rows = JSON.parse(encoded); } catch { throw new Error("CYCLE_CONFIG_JSON"); }
  if (!Array.isArray(rows) || rows.length > 100) throw new Error("CYCLE_CONFIG_LIST");
  const policies = rows.map(parseCyclePolicy);
  if (new Set(policies.map(p => p.operationId)).size !== policies.length) throw new Error("CYCLE_CONFIG_DUPLICATE_OPERATION");
  return policies;
}
export function configuredCyclePolicy(operationId: string, env: Record<string, string | undefined> = process.env): CyclePolicy {
  const policy = configuredCyclePolicies(env).find(p => p.operationId === operationId);
  if (!policy) throw new Error("CYCLE_PRIVATE_OPERATION_UNAVAILABLE");
  return policy;
}
