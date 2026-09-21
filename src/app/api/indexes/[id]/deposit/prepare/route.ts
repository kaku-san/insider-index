import { handleIndexDepositPrepare } from "@/lib/index-vaults/index-deposit";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return handleIndexDepositPrepare(request, (await context.params).id);
}
