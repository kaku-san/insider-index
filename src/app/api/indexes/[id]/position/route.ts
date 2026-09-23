import { handleNavPosition } from "@/lib/nav-vault/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Public positions read the NAV vault (Symmetry retired from public flows). */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return handleNavPosition(request, (await context.params).id);
}
