import { handleNavReadiness } from "@/lib/nav-vault/server";

export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return handleNavReadiness((await context.params).id, undefined, request);
}
