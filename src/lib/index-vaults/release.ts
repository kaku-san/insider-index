/** Research-model metadata only. NAV readiness comes from /api/nav-vault, never this object. */
export const VAULT_RELEASE = {
  mode: "research-model",
  publicFundsEnabled: false,
  nativeUsdcExitVerified: false,
  publicInvestSign: false,
  hostEntryFeeBps: 25,
  hostExitFeeBps: 0,
  exitMode: "unavailable",
  status: "RESEARCH_ONLY",
} as const;
export function unavailableVaultResponse(): Response {
  return Response.json({ ...VAULT_RELEASE, error: "This research-model trading endpoint is retired. Live index investing uses the NAV vault. Individual copy trades remain separate." }, { status: 503, headers: { "Cache-Control": "no-store" } });
}
