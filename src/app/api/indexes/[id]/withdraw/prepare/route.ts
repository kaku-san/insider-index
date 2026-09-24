import { handleNavWithdrawPrepare } from "@/lib/nav-vault/server";

export const runtime = "nodejs";

/** Compatibility endpoint for NAV cash-out preparation. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return handleNavWithdrawPrepare(request, (await context.params).id);
}
