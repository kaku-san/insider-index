import { publicCycleDirectory } from "@/lib/index-vaults/public-cycle-release";
import { vaultIndexService } from "@/lib/index-vaults/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const headers = { "Cache-Control": "private, no-store" };
  try {
    const indexes = await vaultIndexService.list();
    return Response.json(publicCycleDirectory(indexes), { headers });
  } catch {
    return Response.json({ error: "vault-definitions-unavailable" }, { status: 503, headers });
  }
}
