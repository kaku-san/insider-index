import { peopleService } from "@/lib/fmp/server";
import { PeopleError } from "@/lib/fmp/service";

export const runtime = "nodejs";
export async function GET(_request: Request, context: { params: Promise<{ hash: string }> }) {
  const headers = { "Cache-Control": "private, no-store" };
  try {
    const index = await peopleService.publishedIndex((await context.params).hash);
    if (!index) throw new PeopleError(404, "index-not-found");
    return Response.json({ index, storage: "supabase" }, { headers });
  } catch (error) {
    return Response.json({ error: error instanceof PeopleError ? error.code : "saved-data-unavailable" }, { status: error instanceof PeopleError ? error.status : 502, headers });
  }
}
