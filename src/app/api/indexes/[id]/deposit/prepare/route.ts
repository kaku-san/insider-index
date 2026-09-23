import { handleNavDepositPrepare } from "@/lib/nav-vault/server";

export const runtime = "nodejs";

/** Public invest is the NAV vault (Symmetry retired from public flows). */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return handleNavDepositPrepare(request, (await context.params).id);
}
