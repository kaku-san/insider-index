import { handleNavPosition } from "@/lib/nav-vault/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Compatibility endpoint for NAV positions. */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return handleNavPosition(request, (await context.params).id);
}
