import { handleNavDepositPrepare } from "@/lib/nav-vault/server";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return handleNavDepositPrepare(request, (await context.params).id);
}
