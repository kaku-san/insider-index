import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { baseIndexName, indexNames } from "../src/lib/fmp/index-name.ts";

register("./support/ui-loader.mjs", import.meta.url);
const { FmpPerson } = await import("../src/components/fmp-portfolio.tsx");
const { PerformancePanel } = await import("../src/components/person-portfolio.tsx");
const { ProfileView } = await import("../src/components/profile-view.tsx");
const { PrivySolanaProvider } = await import("../src/components/providers/privy-provider.tsx");
type Portfolio = NonNullable<ComponentProps<typeof FmpPerson>["initialData"]>;
const person = { id: "T000001", name: "Test Person", firstName: "Test", lastName: "Person", chamber: "house", state: "CA", party: null, image: null };
const item = (id: string) => ({ id, name: `Disclosed asset ${id}`, ticker: null, kind: "other", owner: "Joint", valueRange: { low: null, high: null }, incomeRange: { low: null, high: 2500 }, mappingReason: "no-source-symbol" });
function book(extra: Record<string, unknown> = {}): Portfolio {
  return { person, snapshots: [], activity: [], publishedIndex: null, indexName: "Test P Index", savedAt: null, state: "partial-disclosure-only", ...extra } as unknown as Portfolio;
}
function render(value: Portfolio) { return renderToStaticMarkup(createElement(PrivySolanaProvider, null, createElement(FmpPerson, { id: person.id, initialData: value }))); }

// Generated HTML is this test's public output contract; no implementation-source inspection.
test("a 65-row annual book renders without a published index, independently of zero saved trades", () => {
  const snapshots = Array.from({ length: 12 }, (_, i) => ({ id: `filing-${i}`, year: 2024 - i, filingDate: `${2025 - i}-05-15`, sourceUrl: null, complete: false, issues: [], items: i === 0 ? Array.from({ length: 65 }, (_, j) => item(String(j))) : [item(`older-${i}`)] }));
  const original = structuredClone(snapshots);
  const html = render(book({ snapshots: [...snapshots].reverse() }));
  for (let i = 0; i < 65; i++) assert.ok(html.includes(`Disclosed asset ${i}</strong>`));
  assert.equal((html.match(/<option /g) ?? []).length, 12);
  assert.match(html, /<dd>65<\/dd>/);
  assert.match(html, /2024-12-31/);
  assert.match(html, /Partial \/ unreconciled source version/);
  assert.match(html, /No trade activity saved/);
  assert.match(html, /No published allocation yet/);
  assert.doesNotMatch(html, /No annual book saved|Disclosed asset older-|Copy latest|19\.5%|\$0|<circle /);
  assert.doesNotMatch(html, /Index not published/);
  assert.deepEqual(snapshots, original);
});

test("published weights stay separate from the entire annual book and never enable investing", () => {
  const index = { hash: "c".repeat(64), person_id: person.id, period: "2025-01-01", version: 2, published_at: "2025-02-01", definition: { label: "Equal weights from reported activity" }, constituents: [{ ticker: "AAA", mint: "mint-a", issuer: "test", weight_bps: 7500 }, { ticker: "BBB", mint: "mint-b", issuer: "test", weight_bps: 2500 }] };
  const html = render(book({ publishedIndex: index, snapshots: [{ id: "filing", year: 2024, filingDate: null, complete: false, sourceUrl: null, issues: [], items: [item("private"), { ...item("unvalued"), ticker: "AAA" }] }] }));
  assert.match(html, /<h1>Test P Index<\/h1>/);
  assert.match(html, /Disclosed asset private/);
  assert.match(html, /Disclosed asset unvalued/);
  assert.match(html, /75\.00%/);
  assert.match(html, /25\.00%/);
  assert.match(html, /Published index target allocation: AAA 75\.0 percent, BBB 25\.0 percent/);
  const annual = html.slice(html.indexOf('id="holdings-title"'), html.indexOf('id="allocation-title"'));
  assert.doesNotMatch(annual, /75\.00%|25\.00%/);
  assert.match(html, /disabled="" aria-describedby="invest-blocker">Basket buying unavailable/);
  assert.match(html, /Research only/);
  assert.match(html, /href="\/feed">Copy one print from the feed/);
});

test("activity uses transaction order and preserves nullable, open-ended ranges and instrument types", () => {
  const trade = { kind: "option", name: "Example call", owner: "Spouse", sourceUrl: "javascript:alert(1)", disclosureDate: "2025-02-01" };
  const html = render(book({ activity: [
    { ...trade, id: "old", ticker: "OLD", transactionDate: "2024-01-01", event: "Sale", amount: { low: null, high: 15000 } },
    { ...trade, id: "new", ticker: "NEW", transactionDate: "2025-01-01", event: "Purchase", amount: { low: 1000000, high: null } },
    { ...trade, id: "unknown", ticker: null, transactionDate: null, event: null, amount: { low: null, high: null } },
  ] }));
  assert.ok(html.indexOf("NEW</strong>") < html.indexOf("OLD</strong>"));
  assert.match(html, /\$1,000,000\+/);
  assert.match(html, /Up to \$15,000/);
  assert.match(html, /Not disclosed/);
  assert.match(html, /option/);
  assert.match(html, /Date unknown/);
  assert.doesNotMatch(html, /href="javascript:|\$0|Execution Price/);
});

test("empty performance has no fabricated curve; real points remain labelled historical simulation", () => {
  const empty = renderToStaticMarkup(createElement(PerformancePanel));
  assert.match(empty, /Historical simulation/);
  assert.match(empty, /S&amp;P 500/);
  assert.doesNotMatch(empty, /polyline|polygon|19\.5%/);
  const measured = renderToStaticMarkup(createElement(PerformancePanel, { points: [{ label: "2025-01-01", equity: 100 }, { label: "2025-01-02", equity: 102 }] }));
  assert.match(measured, /polyline/);
  assert.match(measured, /Historical simulation · not live vault performance/);
  assert.match(measured, /comparison unavailable/);
});

test("legacy insider portfolios use the same uncluttered layout and keep unroutable positions", () => {
  const initialData = { profile: { id: "insider-test", name: "Example Insider", kind: "insider", title: "Officer", imageUrl: null, curve: [], portfolio: [{ ticker: "UNMAPPED", issuerName: "Unmapped company", status: "holding", lastTradeAt: "2025-01-01", valueLow: null, valueHigh: 5000 }], index: { constituents: [] } }, trades: [] } as unknown as NonNullable<ComponentProps<typeof ProfileView>["initialData"]>;
  const html = renderToStaticMarkup(createElement(PrivySolanaProvider, null, createElement(ProfileView, { id: "insider-test", initialData })));
  assert.match(html, /UNMAPPED/);
  assert.match(html, /Up to \$5,000/);
  assert.match(html, /Basket buying unavailable/);
  assert.match(html, /Holdings distribution/);
  assert.doesNotMatch(html, /Copy latest|Buy the index|Tradable basket|followers|role="switch"/);
});

test("automated names use first name and last initial; only actual name collisions append IDs", () => {
  const nancy = { id: "P000197", name: "Nancy Pelosi", firstName: "Nancy", lastName: "Pelosi" };
  const cory = { id: "B001288", name: "Cory Booker", firstName: null, lastName: null };
  const don = { id: "B001292", name: "Don Beyer", firstName: "Don", lastName: "Beyer" };
  assert.equal(baseIndexName(nancy), "Nancy P Index");
  assert.equal(baseIndexName(cory), "Cory B Index");
  assert.equal(baseIndexName(don), "Don B Index");
  assert.equal(indexNames([nancy, cory, don]).get(nancy.id), "Nancy P Index");
  const other = { ...nancy, id: "P000198", name: "Nancy Park", lastName: "Park" };
  const names = indexNames([nancy, other, cory, don]);
  assert.equal(names.get(nancy.id), "Nancy P Index · P000197");
  assert.equal(names.get(other.id), "Nancy P Index · P000198");
  assert.equal(names.get(cory.id), "Cory B Index");
  assert.equal(indexNames([nancy, nancy]).get(nancy.id), "Nancy P Index");
});
