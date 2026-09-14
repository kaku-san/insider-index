import { NextResponse } from "next/server";
import { getAdapterStatus, getRuntimeModes } from "@/lib/health";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(
    {
      ok: true,
      adapters: getAdapterStatus(),
      modes: getRuntimeModes(),
    },
    {
      headers: {
        "Cache-Control": "no-store",
      },
    },
  );
}
