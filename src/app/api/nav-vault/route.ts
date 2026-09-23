import { handleNavVaultList } from "@/lib/nav-vault/server";

export const runtime = "nodejs";

export async function GET(request: Request) {
  return handleNavVaultList(request);
}
