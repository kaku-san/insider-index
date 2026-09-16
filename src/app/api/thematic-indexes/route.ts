import { NextResponse } from "next/server";
import { thematicDirectory } from "@/lib/thematic/views";

export const dynamic = "force-static";

/** Curated multi-member thematic research indexes (live feed). */
export async function GET() {
  const directory = thematicDirectory();
  return NextResponse.json(directory, {
    headers: {
      "Cache-Control": "public, max-age=60, stale-while-revalidate=600",
    },
  });
}
