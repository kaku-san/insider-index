function fallback(mode: "deposit" | "withdraw"): string {
  return mode === "withdraw" ? "Cash out isn't available right now." : "Invest isn't available right now.";
}

export function publicCycleErrorCopy(error: unknown, mode: "deposit" | "withdraw"): string {
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  if (!raw) return fallback(mode);
  if (/CYCLE_|recovery|reconcile|funding|burn|Retain the operation/i.test(raw)) {
    if (/CYCLE_(PUBLIC_POLICY_UNAVAILABLE|ACCESS_WALLET)/.test(raw)) {
      return mode === "withdraw" ? "Cash out isn't available for this wallet." : "Invest isn't available for this wallet.";
    }
    if (/CYCLE_(ACCESS_REQUIRED|CLIENT_SCOPE|CLIENT_WALLET_CHANGED|PUBLIC_DISCOVERY_REQUEST)/.test(raw)) {
      return "Connect your wallet.";
    }
    return fallback(mode);
  }
  return raw.length <= 160 ? raw : fallback(mode);
}

export function publicCycleErrorBody(error: unknown): { error: string; message: string } {
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const code = raw.match(/^CYCLE_[A-Z_]+/)?.[0] ?? "CYCLE_PUBLIC_OPERATION_REFUSED";
  return { error: code, message: publicCycleErrorCopy(new Error(code), "deposit") };
}
