import { getTrackerPerson, trackerSnapshotLabel, TRACKER_AS_OF, TRACKER_SOURCE } from "@/lib/tracker/top20";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const person = getTrackerPerson(id);
  if (!person) return Response.json({ error: "Tracker profile not found." }, { status: 404 });
  return Response.json({
    asOf: TRACKER_AS_OF,
    source: TRACKER_SOURCE,
    label: trackerSnapshotLabel(),
    person,
  });
}
