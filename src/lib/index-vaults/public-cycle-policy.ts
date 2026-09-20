import { createHash } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { parseCyclePolicy } from "./cycle-config.ts";
import type { CyclePolicy } from "./cycle-policy-parse.ts";
import { assertPublicCycleScope } from "./public-cycle-parse.ts";
import { uniquePublicMag7Policy } from "./public-cycle-release.ts";
import { cycleAccessClaims } from "./cycle-access.ts";

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

/** Same Mag7 vault, limits, keeper and economics. The configured owner keeps the original
 * operation id. Any other on-curve wallet gets its own journal; the keeper key is unchanged.
 * Client-supplied limits/operation ids are never accepted. */
export function derivePublicCyclePolicy(template: CyclePolicy, wallet: string): CyclePolicy {
  assertPublicCycleScope(template);
  const key = new PublicKey(wallet);
  if (key.toBase58() !== wallet || !PublicKey.isOnCurve(key.toBytes())) throw new Error("CYCLE_PUBLIC_DISCOVERY_REQUEST");
  if (wallet === template.keeper) throw new Error("CYCLE_PUBLIC_POLICY_UNAVAILABLE");
  if (wallet === template.owner) return template;
  return parseCyclePolicy({ ...template, owner: wallet, operationId: derivePublicCycleOperationId(template.operationId, wallet) });
}

export function publicCyclePolicyForWallet(wallet: string, env: Record<string, string | undefined> = process.env, now = Date.now()): CyclePolicy {
  return derivePublicCyclePolicy(uniquePublicMag7Policy(env, now), wallet);
}

/** Server-side only. HMAC-verified access claims select the derived Mag7 policy; Ed25519 is still
 * checked against that policy's owner before any journal or native work. */
export function resolvePublicCyclePolicy(input: Record<string, unknown>, env: Record<string, string | undefined> = process.env, now = Date.now()): CyclePolicy {
  const template = uniquePublicMag7Policy(env, now);
  if (typeof input.operationId !== "string") throw new Error("CYCLE_REQUEST_ACTION");
  if (input.operationId === template.operationId) return template;
  const claims = cycleAccessClaims(input.auth, env, now);
  if (claims.operationId !== input.operationId) throw new Error("CYCLE_ACCESS_EXPIRED_OR_SCOPE");
  const derived = derivePublicCyclePolicy(template, claims.owner);
  if (derived.operationId !== input.operationId || derived.owner !== claims.owner) throw new Error("CYCLE_PUBLIC_OPERATION_REFUSED");
  return derived;
}
