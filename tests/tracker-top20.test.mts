import assert from "node:assert/strict";
import test from "node:test";
import { getTrackerPerson, listTrackerPeople, TRACKER_AS_OF } from "../src/lib/tracker/top20.ts";

test("tracker snapshot includes all 20 people with Pelosi first", () => {
  const people = listTrackerPeople();
  assert.equal(people.length, 20);
  assert.equal(people[0]?.id, "P000197");
  assert.equal(people[0]?.name, "Nancy Pelosi");
  assert.equal(TRACKER_AS_OF, "2026-09-15");
  assert.equal(new Set(people.map((person) => person.id)).size, 20);
});

test("tracker lookup accepts bioguide id and slug", () => {
  const byId = getTrackerPerson("P000197");
  const bySlug = getTrackerPerson("nancy-pelosi");
  assert.equal(byId?.slug, "nancy-pelosi");
  assert.equal(bySlug?.id, "P000197");
  assert.ok((byId?.holdings.length ?? 0) >= 1);
  assert.ok((byId?.trades.length ?? 0) >= 1);
  assert.equal(getTrackerPerson("missing"), null);
});
