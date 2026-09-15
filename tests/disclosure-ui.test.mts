import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { cloneElement, createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { bookStatus, disclosedRange, filterPeople, personContext } from "../src/lib/frontend/disclosure-labels.ts";
import type { StoredPerson } from "../src/lib/fmp/store.ts";

register("./support/ui-loader.mjs", import.meta.url);
const { IndexHome } = await import("../src/components/index-home.tsx");
const { FmpPerson, PublishedTarget } = await import("../src/components/fmp-person.tsx");
const { PrivySolanaProvider, usePrivySolana } = await import("../src/components/providers/privy-provider.tsx");
function renderPerson(book: NonNullable<ComponentProps<typeof FmpPerson>["initialData"]>) {
  return renderToStaticMarkup(createElement(PrivySolanaProvider, null, createElement(FmpPerson, { id: person.id, initialData: book })));
}

const person: StoredPerson = {
  id: "A000001", provider: "fmp", providerId: "A000001", name: "Example Filer",
  firstName: "Example", lastName: "Filer", chamber: "house", position: "Representative",
  party: null, state: "CA", active: true, image: "https://example.com/portrait.jpg",
  bookState: "partial-disclosure-only", publishedIndexHash: null,
};
const directory = Array.from({ length: 540 }, (_, i) => ({ ...person, id: `A${String(i).padStart(6, "0")}`, name: `Example Filer ${i}`, chamber: i % 2 ? "house" as const : "senate" as const }));

// Assertions below inspect generated HTML, the public render output, not implementation source.
test("home renders index-first discovery, portraits, honest empty models and a bounded full directory", () => {
  const html = renderToStaticMarkup(createElement(IndexHome, { initialData: { people: directory, total: 540, partial: false, savedAt: null, storage: "supabase" } }));
  assert.match(html, /Everyone is/);
  assert.match(html, /class="primaryButton" href="\/feed">Copy one print/);
  assert.ok(html.indexOf("The index desk") < html.indexOf("Names worth knowing"));
  assert.match(html, /540 people/);
  assert.match(html, /Show 24 more people/);
  assert.match(html, /24 of 540/);
  assert.equal((html.match(/class="personRow"/g) ?? []).length, 24);
  assert.match(html, /portrait.jpg/);
  assert.match(html, /No targets have been published yet/);
  assert.doesNotMatch(html, /Capitol Buys|Form-4 CEO|Sign &amp; buy/);
  assert.doesNotMatch(html, />Index</);
});

test("published models use saved publication links, never legacy crowd baskets", () => {
  const hash = "a".repeat(64);
  const html = renderToStaticMarkup(createElement(IndexHome, { initialData: { people: [{ ...person, publishedIndexHash: hash }], total: 1, partial: true, savedAt: null, storage: "supabase" } }));
  assert.match(html, new RegExp(`/indexes/fmp-${hash}`));
  assert.match(html, /1 published/);
  assert.match(html, /Buying is not available/);
  assert.match(html, /Directory coverage is partial/);
});

test("search includes names outside the first page and combines chamber filters without mutating data", () => {
  assert.equal(filterPeople(directory, "  FILER 539  ", "all")[0]?.id, "A000539");
  assert.equal(filterPeople(directory, "A000539", "senate").length, 0);
  assert.equal(filterPeople(directory, "CA", "house").length, 270);
  assert.equal(filterPeople(directory, "no such person", "all").length, 0);
  assert.equal(filterPeople(directory, "", "all").length, 540);
  assert.equal(directory.length, 540);
});

test("disclosure presentation preserves missing and open-ended bands", () => {
  assert.equal(disclosedRange({ low: null, high: null }), "Not disclosed");
  assert.equal(disclosedRange({ low: 1001, high: 15000 }), "$1,001–$15,000");
  assert.equal(disclosedRange({ low: null, high: 5000 }), "Up to $5,000");
  assert.equal(disclosedRange({ low: 1000000, high: null }), "$1,000,000+");
  assert.equal(bookStatus("not-ingested"), "Book pending");
  assert.equal(personContext(person), "House · CA");
});

test("person with no saved book does not claim zero holdings or permit a deposit", () => {
  const book = { person, state: "not-ingested", savedAt: null, snapshots: [], activity: [], publishedIndex: null } as unknown as NonNullable<ComponentProps<typeof FmpPerson>["initialData"]>;
  const html = renderPerson(book);
  assert.match(html, /No annual book saved yet/);
  assert.match(html, /does not mean the person owns nothing/);
  assert.match(html, /Research only/);
  assert.match(html, /disabled=""[^>]*>Basket buying unavailable/);
  assert.match(html, /href="\/feed">Copy one print from the feed/);
  assert.doesNotMatch(html, /Preview devnet deposit|Sign devnet deposit|Invest in this index/);
  assert.doesNotMatch(html, /\$0|Deposit successful|privy-stub:/);
  assert.doesNotMatch(html, /Index not published/);
  assert.ok(html.indexOf("Portfolio performance") < html.indexOf("Current holdings"));
  assert.ok(html.indexOf("Current holdings") < html.indexOf("Holdings distribution"));
  assert.ok(html.indexOf("Holdings distribution") < html.indexOf("Allocation history / trades"));
  assert.match(html, /No published allocation yet/);
  assert.match(html, /Historical simulation/);
  assert.match(html, /S&amp;P 500/);
  assert.match(html, /Saved on this device/);
  assert.doesNotMatch(html, /Copy latest|Buy their index|Copiers|eToro/);
});

test("annual evidence keeps unmapped assets and missing bands, with unsafe source links disabled", () => {
  const item = { id: "item-1", name: "Private partnership", ticker: null, kind: "other", owner: null, valueRange: { low: null, high: null }, incomeRange: { low: 1001, high: 2500 }, mappingReason: "No Solana token", token: null };
  const book = { person, state: "partial-disclosure-only", savedAt: null, activity: [], publishedIndex: null, snapshots: [{ id: "version-1", year: 2025, filingDate: "2026-05-01", complete: false, sourceUrl: "javascript:alert(1)", issues: [], items: [item] }] } as unknown as NonNullable<ComponentProps<typeof FmpPerson>["initialData"]>;
  const html = renderPerson(book);
  assert.match(html, /Private partnership/);
  assert.match(html, /No Solana token/);
  assert.match(html, /Not disclosed/);
  assert.match(html, /\$1,001–\$2,500/);
  assert.match(html, /Source link unavailable/);
  assert.doesNotMatch(html, /href="javascript:|\$0/);
});

test("published target renders actual weights and labels them as mapped annual holdings rather than live ownership", () => {
  const index = { hash: "b".repeat(64), person_id: person.id, period: "2025", version: 1, status: "CANDIDATE", published_at: "2026-01-01T00:00:00Z", definition: { basis: "disclosed-holdings", label: "Example holdings index", snapshotComplete: false, excluded: [] }, constituents: [{ ticker: "TEST", mint: "example-mint", issuer: "Example issuer", weight_bps: 10000 }] } as unknown as ComponentProps<typeof PublishedTarget>["index"];
  const html = renderToStaticMarkup(createElement(PublishedTarget, { index }));
  assert.match(html, /100.00%/);
  assert.match(html, /example-mint/);
  assert.match(html, /mapped annual holdings only—not a live brokerage balance/);
});

test("production fallback cannot authenticate, expose a fixture address, or sign when Privy is missing", async () => {
  const original = process.env.NODE_ENV;
  Object.assign(process.env, { NODE_ENV: "production" });
  let wallet: ReturnType<typeof usePrivySolana> | undefined;
  function CaptureWallet() { wallet = usePrivySolana(); return null; }
  const fallback = createElement(PrivySolanaProvider, null, createElement(CaptureWallet));
  try {
    renderToStaticMarkup(fallback);
    assert.ok(wallet);
    assert.equal(wallet.mode, "unavailable");
    assert.equal(wallet.authenticated, false);
    assert.equal(wallet.solanaAddress, null);
    await assert.rejects(wallet.connect(), /unavailable/);
    await assert.rejects(wallet.signTransaction("test-transaction"), /live wallet is required/);
    await assert.rejects(wallet.signTransaction("test-transaction", "devnet"), /fixtures are never accepted/);
    renderToStaticMarkup(cloneElement(fallback, { pendingLive: true }));
    assert.equal(wallet.ready, false);
    assert.equal(wallet.solanaAddress, null);
    await assert.rejects(wallet.connect(), /still connecting/);
  } finally {
    if (original === undefined) Reflect.deleteProperty(process.env, "NODE_ENV"); else Object.assign(process.env, { NODE_ENV: original });
  }
});
