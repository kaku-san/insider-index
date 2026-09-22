import { handleIndexWithdrawalPrepare } from "@/lib/index-vaults/index-withdraw";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return handleIndexWithdrawalPrepare(request, (await context.params).id);
}
