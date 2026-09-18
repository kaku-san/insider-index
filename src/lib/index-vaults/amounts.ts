import { sha256 as digest } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { PublicKey } from "@solana/web3.js";

export function rawAmount(value: string, positive = false): bigint {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) throw new Error("Canonical raw integer required");
  const raw = BigInt(value);
  if (raw > (1n << 64n) - 1n || (positive && raw === 0n)) throw new Error("Amount outside u64 range");
  return raw;
}
/** SDK 1.0.22 token amounts are raw *numbers*, not display-unit amounts. */
export function sdkRawAmount(value: string): number {
  const raw = rawAmount(value);
  if (raw > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("SDK amount exceeds exact JavaScript integer boundary");
  return Number(raw);
}
export function address(value: string): string {
  if (typeof value !== "string" || new PublicKey(value).toBase58() !== value) throw new Error("Canonical public key required");
  return value;
}
export function sha256(bytes: string | Uint8Array): string {
  return bytesToHex(digest(typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes));
}
/** Stable JSON hashing: no floats/non-JSON values, no dependence on object insertion order. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isSafeInteger(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  throw new Error("Non-canonical JSON value");
}
export function hashObject(value: unknown): string { return sha256(canonicalJson(value)); }
export function weightsValid(assets: { mint: string; targetWeightBps: number }[]): void {
  if (!assets.length || new Set(assets.map(a => address(a.mint))).size !== assets.length ||
      assets.some(a => !Number.isInteger(a.targetWeightBps) || a.targetWeightBps < 0 || a.targetWeightBps > 10_000) ||
      assets.reduce((sum, a) => sum + a.targetWeightBps, 0) !== 10_000) throw new Error("Unique mints and integer weights totaling 10000 required");
}
