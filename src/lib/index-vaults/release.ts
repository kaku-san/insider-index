/** Public release status, safe to import from client code. No environment toggle can enable funds. */
export const VAULT_RELEASE = {
  mode: "native-vault-read-only",
  publicFundsEnabled: false,
  nativeUsdcExitVerified: false,
  hostEntryFeeBps: 25,
  hostExitFeeBps: 0,
  exitMode: "native-underlying-tokens-first",
  status: "WAIT_NATIVE_VERIFICATION",
} as const;
export function unavailableVaultResponse(): Response {
  return Response.json({ ...VAULT_RELEASE, error: "Native index investing is disabled pending deployer setup and verified settlement/claim recovery. Individual copy trades remain separate." }, { status: 503, headers: { "Cache-Control": "no-store" } });
}
