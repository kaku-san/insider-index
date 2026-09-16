import { peopleService } from "@/lib/fmp/server";
import { trackerDirectoryView } from "@/lib/tracker/views";

export const runtime = "nodejs";
const headers = { "Cache-Control": "public, max-age=300, stale-while-revalidate=3600" };

/** All 20 PelosiTracker handoff profiles from the committed dataset; nothing is scraped at request time. */
export async function GET(): Promise<Response> {
  try {
    // Canonical index names come from the saved FMP directory when it is configured; the tracker identity is the fallback.
    const names = await peopleService.directory().then((saved) => new Map(saved.people.flatMap((person) => person.indexName ? [[person.id, person.indexName] as const] : []))).catch((error) => { console.error("tracker-directory-names", error); return null; });
    return Response.json(await trackerDirectoryView(names), { headers });
  }
  catch { return Response.json({ source: "pelositracker.app", error: "tracker-handoff-unavailable" }, { status: 502, headers: { "Cache-Control": "no-store" } }); }
}
