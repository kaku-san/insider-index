import { handleDevnetDeposit } from "../../../../../lib/index-vaults/devnet-deposit.ts";

export const runtime = "nodejs";
export async function POST(request: Request) {
  return handleDevnetDeposit(request, true);
}
