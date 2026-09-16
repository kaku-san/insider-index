import { handleIndexPrepare } from "../../../../../lib/index-vaults/index-vault-create.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  return handleIndexPrepare(request);
}
