import { NextResponse } from "next/server";
import { listPositions } from "@/lib/positions";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const wallet = searchParams.get("wallet") ?? undefined;
  const positions = await listPositions(wallet ?? undefined);

  return NextResponse.json({
    persistence: process.env.SUPABASE_SERVICE_ROLE_KEY ? "supabase" : "memory",
    count: positions.length,
    positions,
  });
}
