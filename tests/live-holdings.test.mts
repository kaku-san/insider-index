import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createClient } from "@supabase/supabase-js";
import { createStoredPeopleService } from "../src/lib/fmp/store.ts";
import { createPeopleHandlers } from "../src/lib/fmp/http.ts";

register("./support/ui-loader.mjs", import.meta.url);
const { FmpPerson } = await import("../src/components/fmp-portfolio.tsx");
const { PrivySolanaProvider } = await import("../src/components/providers/privy-provider.tsx");
const { PublishedTarget } = await import("../src/components/fmp-person.tsx");
const person = { id: "P000197", name: "Nancy Pelosi", firstName: "Nancy", lastName: "Pelosi", chamber: "house", image: null };
const holding = (id: string, name: string, kind = "stock") => ({ id, personId: person.id, name, ticker: null, kind, owner: "Joint", valueRange: { low: null, high: null }, incomeRange: { low: null, high: null }, token: null, mappingReason: "no-source-symbol" });
const items = [holding("nvda", "NVIDIA Corporation [ST]"), holding("axp", "American Express [ST]"), holding("mf", "Matthews International Mutual Fund [MF]", "other"), holding("no-mint", "Unlisted Security [ST]"), ...Array.from({ length: 61 }, (_, i) => holding(`other-${i}`, `Other disclosed asset ${i}`, "other"))];
const snapshots = [{ id: "annual", year: 2024, filingDate: null, complete: false, issues: ["partial-source"], sourceUrl: null, items }];
const constituents = [
  { ticker: "NVDA", mint: "fixture-nvda", issuer: "xstock", weight_bps: 7500 },
  { ticker: "AXP", mint: "fixture-axp", issuer: "backpack", weight_bps: 2500 },
];
const index = { hash: "e".repeat(64), person_id: person.id, period: "2024-12-31", version: 1, status: "CANDIDATE", published_at: "2026-09-14", constituents, definition: {
  basis: "disclosed-holdings", label: "Mapped annual holdings only", snapshotComplete: false,
  evidence: items.map((item, i) => ({ holding: item, ticker: constituents[i]?.ticker ?? (i === 3 ? "NOMINT" : null), token: constituents[i] ? { ...constituents[i], symbol: i === 0 ? "NVDAx" : "AXP.US" } : null, method: i < 2 ? "fmp-exact-name" : "unresolved", reason: i < 2 ? null : "no-solana-mint" })),
  excluded: items.slice(2).map((item) => ({ holdingId: item.id, ticker: null, name: item.name, reason: "no-solana-mint" })),
} };

function service() {
  return createStoredPeopleService(createClient("https://saved.example.test", "test-only", { auth: { persistSession: false }, global: { fetch: async (input, init) => {
    assert.ok(!init?.method || init.method === "GET", "public reads must not write or ingest");
    const url = new URL(String(input));
    assert.equal(url.host, "saved.example.test", "no FMP network requests");
    if (url.pathname.endsWith("people")) return Response.json(url.searchParams.has("id") ? { payload: person, portfolio: { snapshots, activity: [], bookComplete: false, complete: false, partial: true }, saved_at: "2026-09-14" } : [{ payload: person, book_state: "partial-disclosure-only" }]);
    if (url.pathname.endsWith("fmp_store_state")) return Response.json(null);
    assert.ok(url.pathname.endsWith("index_versions"));
    // Emulate actual Supabase filtering: the former trade-only reader must miss this record.
    const match = url.searchParams.get("definition->>basis") === `eq.${index.definition.basis}` && url.searchParams.get("status") === `eq.${index.status}`;
    return Response.json(url.searchParams.has("hash") ? match ? index : null : url.searchParams.has("person_id") ? match ? { hash: index.hash } : null : match ? [{ hash: index.hash, person_id: person.id }] : []);
  } } }));
}

test("live people handlers return holdings-first weights with 65 unchanged items and no trade prerequisite", async () => {
  const original = structuredClone(snapshots);
  const handlers = createPeopleHandlers(service());
  const response = await handlers.portfolio(new Request("https://app.test"), { params: Promise.resolve({ id: person.id }) });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  const body = await response.json();
  assert.deepEqual(body.snapshots, original);
  assert.equal(body.activity.length, 0);
  assert.equal(body.publishedIndex.hash, index.hash);
  assert.equal(body.publishedIndex.definition.basis, "disclosed-holdings");
  assert.deepEqual(body.publishedIndex.constituents, constituents);
  const directory = await (await handlers.directory(new Request("https://app.test/api/people?q=Pelosi"))).json();
  assert.equal(directory.people[0].publishedIndexHash, index.hash);
  assert.equal(directory.people[0].indexName, body.publishedIndex.indexName);
  assert.equal((await service().publishedIndex(index.hash))?.hash, index.hash);
  assert.deepEqual(snapshots, original);
});

test("portfolio HTML shows persisted pie, ticker and venue overlays while keeping mutual funds and no-mint rows", async () => {
  const value = await service().portfolio(person.id);
  const before = structuredClone(value);
  const html = renderToStaticMarkup(createElement(PrivySolanaProvider, null, createElement(FmpPerson, { id: person.id, initialData: value })));
  assert.match(html, /Published index target allocation: NVDA 75\.0 percent, AXP 25\.0 percent/);
  assert.match(html, /<strong>NVDA<\/strong><small>NVIDIA Corporation \[ST\]/);
  assert.match(html, /xStock · NVDAx/);
  assert.match(html, /Backpack · AXP.US/);
  assert.match(html, /Matthews International Mutual Fund \[MF\]/);
  assert.match(html, /<strong>NOMINT<\/strong>/);
  assert.match(html, /Disclosed-only · no mapped Solana mint/);
  assert.match(html, /Partial annual source: mapped observed holdings only/);
  assert.match(html, /<dd>65<\/dd>/);
  assert.match(html, /No trade activity saved/);
  assert.doesNotMatch(html, /No published allocation yet|Activity through|\$0/);
  assert.match(html, /disabled="" aria-describedby="invest-blocker">Basket buying unavailable/);
  const annual = html.slice(html.indexOf('id="holdings-title"'), html.indexOf('id="allocation-title"'));
  assert.doesNotMatch(annual, /75\.00%|25\.00%/);
  assert.deepEqual(value, before);
  const target = renderToStaticMarkup(createElement(PublishedTarget, { index: value.publishedIndex! }));
  assert.match(target, /Published holdings target/);
  assert.match(target, /Holdings reference 2024-12-31/);
  assert.match(target, /Matthews International Mutual Fund/);
  assert.doesNotMatch(target, /Activity-weighted|trade activity/);
});
