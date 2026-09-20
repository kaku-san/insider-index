import { handlePublicCycleRequest } from "@/lib/index-vaults/public-cycle-api";

export const runtime = "nodejs";
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return handlePublicCycleRequest(request, (await context.params).id);
}
