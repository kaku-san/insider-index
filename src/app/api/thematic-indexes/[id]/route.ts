import { NextResponse } from "next/server";
import { getThematicView } from "@/lib/thematic/views";

export const dynamic = "force-static";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const view = getThematicView(id);
  if (!view) {
    return NextResponse.json({ error: "Thematic index not found" }, { status: 404 });
  }
  return NextResponse.json(
    { index: view, storage: "static-feed" },
    { headers: { "Cache-Control": "public, max-age=60, stale-while-revalidate=600" } },
  );
}
