import { listTrackerPeople, trackerSnapshotLabel, TRACKER_AS_OF, TRACKER_SOURCE } from "@/lib/tracker/top20";

export const dynamic = "force-dynamic";

export async function GET() {
  const people = listTrackerPeople();
  return Response.json({
    asOf: TRACKER_AS_OF,
    source: TRACKER_SOURCE,
    label: trackerSnapshotLabel(),
    count: people.length,
    people,
  });
}
