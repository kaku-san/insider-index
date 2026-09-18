import { VAULT_RELEASE } from "@/lib/index-vaults/release";
import { vaultIndexService } from "@/lib/index-vaults/server";

export const runtime = "nodejs";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const headers = { "Cache-Control": "private, no-store" };
  const { id } = await context.params;
  if (!/^(insiderindex-|idx-theme-)[a-z0-9-]+$/.test(id)) {
    return Response.json({ error: "invalid-index-id" }, { status: 400, headers });
  }
  try {
    const index = await vaultIndexService.get(id);
    if (!index) return Response.json({ error: "index-not-found" }, { status: 404, headers });
    return Response.json({
      index: {
        hash: index.indexId,
        person_id: index.bioguideId ?? index.personSlug,
        indexName: index.name,
        period: index.provenance.fmpYear ? String(index.provenance.fmpYear) : undefined,
        version: 1,
        status: index.status,
        published_at: index.updatedAt,
        vaultAddress: index.vaultAddress,
        shareMint: index.shareMint,
        definition: {
          basis: index.weightBasis,
          methodology: index.weightBasis,
          label: index.provenance.note ?? "Published native index definition.",
          excluded: index.unmapped.map((item) => ({ ticker: item.ticker, name: item.name ?? null, reason: item.reason ?? "no-solana-mint" })),
        },
        constituents: index.legs.map((leg) => ({
          ticker: leg.ticker,
          mint: leg.mint,
          issuer: leg.provider,
          weight_bps: leg.targetWeightBps,
          book_weight_bps: leg.bookWeightBps,
          vault_ready: leg.vaultReady,
        })),
      },
      coverageBps: index.coverage.mappableByWeightBps ?? null,
      coverage: index.coverage,
      unmapped: index.unmapped,
      personSlug: index.personSlug,
      activityProfileId: index.bioguideId,
      depositsEnabled: index.depositsEnabled,
      depositReason: index.depositReason,
      publicFundsEnabled: VAULT_RELEASE.publicFundsEnabled,
      storage: "supabase",
    }, { headers });
  } catch {
    return Response.json({ error: "vault-definition-unavailable" }, { status: 503, headers });
  }
}
