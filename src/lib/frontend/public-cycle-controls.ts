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
export function publicCycleNextRequest(mode: "deposit" | "withdraw", state: Pick<CycleState, "phase" | "pending" | "recoveryRequired">, depositsEnabled = true): "next" | "withdraw" | "recover" | null {
  if (state.pending || state.phase === "complete") return null;
  if (state.recoveryRequired) return "recover";
  if (state.phase === "exiting" || state.phase === "recovering") return "next";
  if (mode === "withdraw") return state.phase === "holding" ? "withdraw" : null;
  return depositsEnabled ? "next" : null;
}

export type PublicCycleCtaAction = "connect" | "discover" | "authorize" | "prepare" | "sign" | "retry";
export type PublicCyclePrimaryCta = { action: PublicCycleCtaAction; label: string } | null;

/** The modal has one progressive action. Refresh is deliberately separate from this control. */
export function publicCyclePrimaryCta(input: {
  mode: "deposit" | "withdraw";
  walletConnected: boolean;
  accessReady: boolean;
  authorized: boolean;
  pending: boolean;
  canRetry: boolean;
  /** Legacy journals can ask the user to resume their saved amount after a failed restart. */
  resumeSavedAmount?: boolean;
  nextRequest: "next" | "withdraw" | "recover" | null;
}): PublicCyclePrimaryCta {
  if (!input.walletConnected) return { action: "connect", label: "Connect wallet" };
  if (!input.accessReady) return { action: "discover", label: input.mode === "deposit" ? input.resumeSavedAmount ? "Continue investment" : "Review amount" : "Cash out to USDC" };
  if (!input.authorized) return { action: "authorize", label: "Confirm in wallet" };
  if (input.pending) return input.canRetry ? { action: "retry", label: "Retry signed action" } : { action: "sign", label: "Sign in wallet" };
  if (!input.nextRequest) return null;
  if (input.nextRequest === "recover") return { action: "prepare", label: "Prepare cash out" };
  if (input.mode === "withdraw") return { action: "prepare", label: "Cash out to USDC" };
  return { action: "prepare", label: "Prepare investment" };
}
