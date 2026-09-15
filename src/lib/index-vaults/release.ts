/** Public release status, safe to import from client code. No environment toggle can enable funds. */
export const VAULT_RELEASE = {
  mode: "native-vault-full-cycle-gated",
  publicFundsEnabled: false,
  nativeUsdcExitVerified: false,
  publicInvestSign: false,
  hostEntryFeeBps: 25,
  hostExitFeeBps: 0,
  exitMode: "zap-usdc-only-unproven",
  status: "WAIT_FULL_CYCLE_RECEIPT",
} as const;
export function unavailableVaultResponse(): Response {
  return Response.json({ ...VAULT_RELEASE, error: "Native index investing is disabled until create→mint→rebalance→USDC-out has a receipt. Individual copy trades remain separate." }, { status: 503, headers: { "Cache-Control": "no-store" } });
}
