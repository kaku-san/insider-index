export function publicCycleErrorCopy(error: unknown, mode: "deposit" | "withdraw"): string {
  const code = error instanceof Error ? error.message : "";
  if (/CYCLE_(PUBLIC_POLICY_UNAVAILABLE|ACCESS_REQUIRED|CLIENT_SCOPE|CLIENT_WALLET_CHANGED)/.test(code)) {
    return "Connect the wallet used for Mag7.";
  }
  return mode === "withdraw" ? "Cash out isn't available right now." : "Invest isn't available for this wallet.";
}
