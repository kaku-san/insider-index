import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519";
import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { canonicalJson } from "./amounts.ts";
import { cyclePolicyHash, type CyclePolicy } from "./cycle-policy-parse.ts";
export interface CycleAccessChallenge { token: string; message: string; expiresAt: number; }
export interface CycleAccessProof { token: string; signature: string; }
type Claims = { origin: string; owner: string; operationId: string; policyHash: string; nonce: string; issuedAt: number; expiresAt: number; };
const LIFETIME_MS = 120000;
function secret(env: Record<string, string | undefined>): string {
  const value = env.STOCKLANA_CYCLE_AUTH_SECRET;
  if (!value || value.length < 32 || value.length > 1024) throw new Error("CYCLE_ACCESS_UNCONFIGURED");
  return value;
}
function message(c: Claims): string {
  return `InsiderIndex.xyz private native cycle access\nOrigin: ${c.origin}\nWallet: ${c.owner}\nOperation: ${c.operationId}\nPolicy: ${c.policyHash}\nNonce: ${c.nonce}\nExpires: ${new Date(c.expiresAt).toISOString()}\nRead, prepare unsigned steps and reconcile this operation. Relay ONLY my separately signed exact transaction. This message is not a transaction, token approval, or discretionary spending authority.`;
}
function mac(encoded: string, env: Record<string, string | undefined>): Buffer { return createHmac("sha256", secret(env)).update(`insiderindex-cycle-access-v1:${encoded}`).digest(); }
export function createCycleAccessChallenge(policy: CyclePolicy, origin: string, env: Record<string, string | undefined> = process.env, now = Date.now()): CycleAccessChallenge {
  const c: Claims = { origin, owner: policy.owner, operationId: policy.operationId, policyHash: cyclePolicyHash(policy), nonce: randomBytes(24).toString("hex"), issuedAt: now, expiresAt: now + LIFETIME_MS };
  const encoded = Buffer.from(canonicalJson(c)).toString("base64url");
  return { token: `${encoded}.${mac(encoded, env).toString("base64url")}`, message: message(c), expiresAt: c.expiresAt };
}
export function assertCycleAccess(proof: unknown, policy: CyclePolicy, origin: string, env: Record<string, string | undefined> = process.env, now = Date.now()): void {
  if (!proof || typeof proof !== "object" || Array.isArray(proof) || Object.keys(proof).length !== 2 || !("token" in proof) || !("signature" in proof) || typeof proof.token !== "string" || proof.token.length > 2500 || typeof proof.signature !== "string" || proof.signature.length > 100) throw new Error("CYCLE_ACCESS_REQUIRED");
  const [encoded, signed, extra] = proof.token.split(".");
  if (!encoded || !signed || extra !== undefined) throw new Error("CYCLE_ACCESS_INVALID");
  const expected = mac(encoded, env), actual = Buffer.from(signed, "base64url");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error("CYCLE_ACCESS_INVALID");
  let c: Claims; try { c = JSON.parse(Buffer.from(encoded, "base64url").toString()); } catch { throw new Error("CYCLE_ACCESS_INVALID"); }
  if (c.origin !== origin || c.owner !== policy.owner || c.operationId !== policy.operationId || c.policyHash !== cyclePolicyHash(policy) || !Number.isSafeInteger(c.issuedAt) || !Number.isSafeInteger(c.expiresAt) || c.issuedAt > now || c.expiresAt <= now || c.expiresAt - c.issuedAt !== LIFETIME_MS) throw new Error("CYCLE_ACCESS_EXPIRED_OR_SCOPE");
  let signature: Uint8Array; try { signature = bs58.decode(proof.signature); } catch { throw new Error("CYCLE_ACCESS_SIGNATURE"); }
  if (signature.length !== 64 || !ed25519.verify(signature, new TextEncoder().encode(message(c)), new PublicKey(policy.owner).toBytes(), { zip215: false })) throw new Error("CYCLE_ACCESS_SIGNATURE");
}
