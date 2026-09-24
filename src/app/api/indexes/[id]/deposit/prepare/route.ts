import { handleNavDepositPrepare } from "@/lib/nav-vault/server";

export const runtime = "nodejs";

/** Compatibility endpoint for NAV deposit preparation. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return handleNavDepositPrepare(request, (await context.params).id);
}
