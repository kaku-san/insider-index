import { handleNavWithdrawPrepare } from "@/lib/nav-vault/server";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return handleNavWithdrawPrepare(request, (await context.params).id);
}
