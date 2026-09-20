import { createHash } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { parseCyclePolicy } from "./cycle-config.ts";
import type { CyclePolicy } from "./cycle-policy-parse.ts";
import { assertPublicCycleScope } from "./public-cycle-parse.ts";
import { uniquePublicMag7Policy } from "./public-cycle-release.ts";
import { cycleAccessClaims } from "./cycle-access.ts";
import { rawAmount, sdkRawAmount } from "./amounts.ts";
import { cycleRpcFromEnv, type CycleRpc } from "./cycle-store.ts";
import { cyclePolicyHash } from "./cycle-policy-parse.ts";

/** RFC 4122 UUID v5 so each Mag7 depositor resumes the same journal without a second configured policy. */
export function derivePublicCycleOperationId(templateOperationId: string, wallet: string): string {
  const hex = templateOperationId.replace(/-/g, "");
  if (!/^[0-9a-f]{32}$/i.test(hex)) throw new Error("CYCLE_PUBLIC_SCOPE");
  const hash = createHash("sha1").update(Buffer.from(hex, "hex")).update(wallet).digest();
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const h = hash.subarray(0, 16).toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** Same Mag7 vault/keeper/economics. Only the deposit amount is user-selected. Proportional
 * minimum shares/exit preserve the approved economics; slippage and cost budgets never widen. */
export function derivePublicCyclePolicy(template: CyclePolicy, wallet: string, depositUsdcRaw?: string): CyclePolicy {
  assertPublicCycleScope(template);
  const key = new PublicKey(wallet);
  if (key.toBase58() !== wallet || !PublicKey.isOnCurve(key.toBytes())) throw new Error("CYCLE_PUBLIC_DISCOVERY_REQUEST");
  if (wallet === template.keeper) throw new Error("CYCLE_PUBLIC_POLICY_UNAVAILABLE");
  let limits = template.limits;
  if (depositUsdcRaw !== undefined) {
    if (typeof depositUsdcRaw !== "string" || !/^[1-9]\d{0,15}$/.test(depositUsdcRaw)) throw new Error("CYCLE_PUBLIC_AMOUNT_INVALID");
    try { sdkRawAmount(depositUsdcRaw); } catch { throw new Error("CYCLE_PUBLIC_AMOUNT_INVALID"); }
    const amount = rawAmount(depositUsdcRaw, true), base = rawAmount(template.limits.depositUsdcRaw, true);
    const scaledMinimum = (value: string) => ((rawAmount(value, true) * amount + base - 1n) / base).toString();
    limits = { ...limits, depositUsdcRaw, minNetSharesRaw: scaledMinimum(limits.minNetSharesRaw), minExitUsdcRaw: scaledMinimum(limits.minExitUsdcRaw) };
  }
  return parseCyclePolicy({ ...template, limits, owner: wallet, operationId: wallet === template.owner ? template.operationId : derivePublicCycleOperationId(template.operationId, wallet) });
}

/** Resume the amount already committed in the shared journal, including after a reload or
 * access-token expiry. Read failures never silently select a new amount. Old rows use the template. */
export async function resumePublicCyclePolicy(template: CyclePolicy, wallet: string, depositUsdcRaw?: string, rpc: CycleRpc = cycleRpcFromEnv()): Promise<CyclePolicy> {
  const requested = derivePublicCyclePolicy(template, wallet, depositUsdcRaw);
  const value = await rpc("read_insiderindex_cycle", { p_operation_id: requested.operationId });
  if (value === null) return requested;
  if (!value || typeof value !== "object" || !("state" in value) || !value.state || typeof value.state !== "object") throw new Error("CYCLE_JOURNAL_UNREADABLE");
  const state = value.state as { approvedDepositUsdcRaw?: string; policyHash?: string };
  const saved = derivePublicCyclePolicy(template, wallet, state.approvedDepositUsdcRaw);
  if (cyclePolicyHash(saved) !== state.policyHash) throw new Error("CYCLE_JOURNAL_IDENTITY_OR_POLICY_CHANGED");
  if (depositUsdcRaw !== undefined && requested.limits.depositUsdcRaw !== saved.limits.depositUsdcRaw) throw new Error("CYCLE_PUBLIC_AMOUNT_ALREADY_SELECTED");
  return saved;
}

export async function publicCyclePolicyForWallet(wallet: string, env: Record<string, string | undefined> = process.env, now = Date.now(), depositUsdcRaw?: string, rpc?: CycleRpc): Promise<CyclePolicy> {
  return resumePublicCyclePolicy(uniquePublicMag7Policy(env, now), wallet, depositUsdcRaw, rpc);
}

/** Server-side only. HMAC-verified access claims select the derived Mag7 policy; Ed25519 is still
 * checked against that policy's owner before any journal or native work. */
export function resolvePublicCyclePolicy(input: Record<string, unknown>, env: Record<string, string | undefined> = process.env, now = Date.now()): CyclePolicy {
  const template = uniquePublicMag7Policy(env, now);
  if (typeof input.operationId !== "string") throw new Error("CYCLE_REQUEST_ACTION");
  // The private handler still validates fields and refuses missing owner authentication.
  if (input.operationId === template.operationId && !input.auth) return template;
  const claims = cycleAccessClaims(input.auth, env, now);
  if (claims.operationId !== input.operationId) throw new Error("CYCLE_ACCESS_EXPIRED_OR_SCOPE");
  const derived = derivePublicCyclePolicy(template, claims.owner, claims.depositUsdcRaw);
  if (derived.operationId !== input.operationId || derived.owner !== claims.owner) throw new Error("CYCLE_PUBLIC_OPERATION_REFUSED");
  return derived;
}
