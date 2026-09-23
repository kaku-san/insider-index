import { handleNavPositions } from "@/lib/nav-vault/server";
import { vaultIndexService } from "@/lib/index-vaults/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Wallet positions across NAV vaults (Symmetry retired from public flows). */
export async function GET(request: Request) {
  return handleNavPositions(request, { listIndexes: vaultIndexService.list });
}
