import { handleCycleRequest } from "../../../../lib/index-vaults/cycle-api.ts";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request) { return handleCycleRequest(request); }
