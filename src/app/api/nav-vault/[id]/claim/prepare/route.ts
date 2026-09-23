import { handleNavClaimPrepare } from "@/lib/nav-vault/server";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return handleNavClaimPrepare(request, (await context.params).id);
}
