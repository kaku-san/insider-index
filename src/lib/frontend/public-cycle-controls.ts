import type { CycleState } from "../index-vaults/cycle-store.ts";

/** Exact six-decimal USDC parsing; no floating-point rounding or product deposit cap. */
export function publicDepositAmountRaw(text: string): string {
  if (!/^(0|[1-9]\d{0,9})(\.\d{1,6})?$/.test(text)) throw new Error("CYCLE_PUBLIC_AMOUNT_INVALID");
  const [whole, fraction = ""] = text.split(".");
  const raw = BigInt(whole) * 1000000n + BigInt(fraction.padEnd(6, "0"));
  if (raw <= 0n || raw > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("CYCLE_PUBLIC_AMOUNT_INVALID");
  return raw.toString();
}

/** Withdrawal is not done at the burn: claims, cleanup and every USDC conversion must run. */
export function publicCycleNextRequest(mode: "deposit" | "withdraw", state: Pick<CycleState, "phase" | "pending" | "recoveryRequired">): "next" | "withdraw" | "recover" | null {
  if (state.pending || state.phase === "complete") return null;
  if (state.recoveryRequired) return "recover";
  if (state.phase === "exiting" || state.phase === "recovering") return "next";
  if (mode === "withdraw") return state.phase === "holding" ? "withdraw" : null;
  return state.phase === "holding" ? null : "next";
}
