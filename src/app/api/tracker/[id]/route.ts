import { peopleService } from "@/lib/fmp/server";
import { trackerPersonView } from "@/lib/tracker/views";

export const runtime = "nodejs";
const headers = { "Cache-Control": "public, max-age=300, stale-while-revalidate=3600" };

/** One handoff profile plus its tracker-positions index. Unknown IDs are 404, never an invented person. */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await context.params;
  if (!/^[A-Z][0-9]{6}$/.test(id)) return Response.json({ source: "pelositracker.app", error: "invalid-person-id" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  try {
    const savedIndexName = await peopleService.portfolio(id).then((saved) => saved.indexName).catch(() => null);
    const view = await trackerPersonView(id, savedIndexName);
    if (!view) return Response.json({ source: "pelositracker.app", error: "not-in-tracker-handoff" }, { status: 404, headers: { "Cache-Control": "no-store" } });
    return Response.json(view, { headers });
  } catch { return Response.json({ source: "pelositracker.app", error: "tracker-handoff-unavailable" }, { status: 502, headers: { "Cache-Control": "no-store" } }); }
}
