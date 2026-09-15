import brief from "../../../data/insiderindex-source-buckets/pelositracker-top20full-handoff/top20-agent-brief.json" with { type: "json" };
import { globalState } from "../cache.ts";
import { normalizeTrackerHandoff, trackerSummary, type TrackerHandoff, type TrackerProfile, type TrackerSummary } from "./tracker-parse.ts";

/**
 * The committed PelosiTracker full handoff is the product dataset: every one of the 20 profiles is
 * served from this bundle, so no page ever scrapes the tracker. The raw bucket under
 * `data/insiderindex-source-buckets/pelositracker-top20full-handoff/` (itemized in its MANIFEST.json)
 * is the source; the earlier slice-only zip stays at `pelositracker-top20-handoff/`. Photos are
 * mirrored to `public/tracker/photos/`.
 */
export function trackerHandoff(): TrackerHandoff {
  return globalState("tracker_handoff", () => normalizeTrackerHandoff(brief));
}

export function trackerProfile(id: string): TrackerProfile | null {
  return trackerHandoff().profiles.find((profile) => profile.id === id) ?? null;
}

export function trackerProfileBySlug(slug: string): TrackerProfile | null {
  return trackerHandoff().profiles.find((profile) => profile.slug === slug) ?? null;
}

export function trackerSummaries(): TrackerSummary[] {
  return trackerHandoff().profiles.map(trackerSummary);
}

export function isTrackerPerson(id: string): boolean {
  return trackerProfile(id) !== null;
}
