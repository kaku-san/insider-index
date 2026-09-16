import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";

// peopleService (src/lib/fmp/server.ts) calls a helper that throws synchronously when Supabase
// is unconfigured. These routes must still serve the committed PelosiTracker handoff dataset
// instead of failing with a 502, matching the product's "browsable without live scrape" intent.
delete process.env.NEXT_PUBLIC_SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

register("./support/ui-loader.mjs", import.meta.url);
const { GET: directory } = await import("../src/app/api/tracker/route.ts");
const { GET: person } = await import("../src/app/api/tracker/[id]/route.ts");

test("GET /api/tracker serves all 20 handoff profiles when Supabase is unconfigured", async () => {
  const response = await directory();
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.source, "pelositracker.app");
  assert.equal(body.people.length, 20);
});

test("GET /api/tracker/[id] serves one handoff profile and its tracker index when Supabase is unconfigured", async () => {
  const response = await person(new Request("https://app.test"), { params: Promise.resolve({ id: "P000197" }) });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.profile.id, "P000197");
  assert.ok(body.index);
});
