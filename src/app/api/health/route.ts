import { NextResponse } from "next/server";
import { getAdapterStatus } from "@/lib/health";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(
    {
      ok: true,
      adapters: getAdapterStatus(),
    },
    {
      headers: {
        "Cache-Control": "no-store",
      },
    },
  );
}
