import { publicVaultDirectory } from "@/lib/index-vaults/public-directory";
import { vaultIndexService } from "@/lib/index-vaults/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const headers = { "Cache-Control": "private, no-store" };
  try {
    const indexes = await vaultIndexService.list();
    return Response.json(publicVaultDirectory(indexes), { headers });
  } catch {
    return Response.json({ error: "vault-definitions-unavailable" }, { status: 503, headers });
  }
}
