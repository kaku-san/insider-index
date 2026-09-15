import { handleKakuSanObserve } from "../../../../../lib/index-vaults/kaku-san-create.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  return handleKakuSanObserve(request);
}
