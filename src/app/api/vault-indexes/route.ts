import { VAULT_RELEASE } from "@/lib/index-vaults/release";
import { vaultIndexService } from "@/lib/index-vaults/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const headers = { "Cache-Control": "private, no-store" };
  try {
    const indexes = await vaultIndexService.list();
    return Response.json({
      count: indexes.length,
      indexes,
      publicFundsEnabled: VAULT_RELEASE.publicFundsEnabled,
      storage: "supabase",
    }, { headers });
  } catch {
    return Response.json({ error: "vault-definitions-unavailable" }, { status: 503, headers });
  }
}
