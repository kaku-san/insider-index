import { handleIndexPosition } from "@/lib/index-vaults/index-positions";
import { vaultIndexService } from "@/lib/index-vaults/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return handleIndexPosition(request, id, { getIndex: vaultIndexService.get });
}
