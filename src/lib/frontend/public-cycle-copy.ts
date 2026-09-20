function fallback(mode: "deposit" | "withdraw"): string {
  return mode === "withdraw" ? "Cash out isn't available right now." : "Invest isn't available right now.";
}

export function publicCycleErrorCopy(error: unknown, mode: "deposit" | "withdraw"): string {
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  if (!raw) return fallback(mode);
  if (/CYCLE_PUBLIC_AMOUNT_INVALID/.test(raw)) return "Enter a positive USDC amount with up to six decimal places.";
  if (/CYCLE_PUBLIC_AMOUNT_ALREADY_SELECTED/.test(raw)) return "An investment is already in progress. Use Resume to continue.";
  if (/CYCLE_INSUFFICIENT_USDC/.test(raw)) return "You don’t have enough USDC for this amount.";
  if (/CYCLE_AMOUNT_CANNOT_REPRESENT_MINIMUM_SHARES/.test(raw)) return "This amount is too small to buy shares. Try a larger amount.";
  if (/CYCLE_(EXIT_.*MINIMUM|EXIT_PREREQUISITE|ROUTE_MINIMUM|WALLET_AFTER_FEE_EXIT_MINIMUM)/.test(raw)) return "The current USDC quote is below your minimum. Try again later.";
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

export function publicCycleErrorBody(error: unknown): { error: string; message: string; code: string } {
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const code = raw.match(/^CYCLE_[A-Z_]+/)?.[0] ?? "CYCLE_PUBLIC_OPERATION_REFUSED";
  const copy = publicCycleErrorCopy(new Error(code), "deposit");
  return { error: copy, message: copy, code };
}
