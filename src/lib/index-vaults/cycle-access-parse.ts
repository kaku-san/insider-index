import { cyclePolicyHash, type CyclePolicy } from "./cycle-policy-parse.ts";
export interface CycleAccessClaims { origin: string; owner: string; operationId: string; policyHash: string; nonce: string; issuedAt: number; expiresAt: number; }
export interface CycleAccessChallenge { token: string; message: string; expiresAt: number; }
export interface CycleAccessProof { token: string; signature: string; }
export function cycleAccessMessage(c: CycleAccessClaims): string {
  return `InsiderIndex.xyz private native cycle access\nOrigin: ${c.origin}\nWallet: ${c.owner}\nOperation: ${c.operationId}\nPolicy: ${c.policyHash}\nNonce: ${c.nonce}\nExpires: ${new Date(c.expiresAt).toISOString()}\nRead, prepare unsigned steps and reconcile this operation. Relay ONLY my separately signed exact transaction. This message is not a transaction, token approval, or discretionary spending authority.`;
}
/** Before opening signMessage, independently constrain the text to access-only semantics.
 * HMAC verification belongs to the server; this check is not a bearer-session verifier. */
export function validateCycleAccessMessage(challenge: CycleAccessChallenge, policy: CyclePolicy, origin: string, wallet: string, now = Date.now()): string {
  if (wallet !== policy.owner || typeof challenge.token !== "string" || challenge.token.length > 2500 || challenge.token.split(".").length !== 2) throw new Error("CYCLE_ACCESS_CHALLENGE_SCOPE");
  const c = JSON.parse(Buffer.from(challenge.token.split(".")[0].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString()) as CycleAccessClaims;
  if (c.origin !== origin || c.owner !== wallet || c.operationId !== policy.operationId || c.policyHash !== cyclePolicyHash(policy) || !/^[a-f0-9]{48}$/.test(c.nonce) || !Number.isSafeInteger(c.issuedAt) || c.issuedAt > now || !Number.isSafeInteger(c.expiresAt) || c.expiresAt <= now || c.expiresAt - c.issuedAt !== 120000 || c.expiresAt !== challenge.expiresAt) throw new Error("CYCLE_ACCESS_CHALLENGE_SCOPE");
  const expected = cycleAccessMessage(c);
  if (challenge.message !== expected) throw new Error("CYCLE_ACCESS_CHALLENGE_TEXT");
  return expected;
}
