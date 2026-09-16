import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TrackerListResponse, TrackerPerson } from "./types.ts";

export const TRACKER_AS_OF = "2026-09-15";
export const TRACKER_SOURCE = "pelositracker.app";
export type { TrackerHolding, TrackerPerson, TrackerPoint, TrackerTrade } from "./types.ts";

const data = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "top20-snapshot.json"), "utf8"),
) as TrackerListResponse;

export function trackerSnapshotLabel(): string {
  return data.label;
}

export function listTrackerPeople(): TrackerPerson[] {
  return data.people;
}

export function getTrackerPerson(id: string): TrackerPerson | null {
  const key = decodeURIComponent(id).trim();
  return data.people.find((person) => person.id === key || person.slug === key) ?? null;
}
