import { handleDevnetPositions } from "../../../lib/index-vaults/devnet-positions.ts";

export const runtime = "nodejs";

export async function GET(request: Request) {
  return handleDevnetPositions(request);
}
