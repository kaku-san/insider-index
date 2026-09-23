import { handleNavWithdrawPrepare } from "@/lib/nav-vault/server";

export const runtime = "nodejs";

/** Public cash-out is the NAV vault (Symmetry retired from public flows). */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return handleNavWithdrawPrepare(request, (await context.params).id);
}
