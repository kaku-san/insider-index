import { handleIndexPositions } from "@/lib/index-vaults/index-positions";
import { vaultIndexService } from "@/lib/index-vaults/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return handleIndexPositions(request, { listIndexes: vaultIndexService.list });
}
