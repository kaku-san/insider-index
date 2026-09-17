import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { cloneElement, createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { bookStatus, disclosedRange, filterPeople, personContext } from "../src/lib/frontend/disclosure-labels.ts";
import type { StoredPerson } from "../src/lib/fmp/store.ts";
import type { PublicVaultDefinition } from "../src/lib/index-vaults/vault-definition-store.ts";

register("./support/ui-loader.mjs", import.meta.url);
const { ConsumerHome, FilingTape } = await import("../src/components/consumer-home.tsx");
const { poolReadinessLabel } = await import("../src/components/consumer-index.tsx");
const { FmpPerson, PublishedTarget } = await import("../src/components/fmp-person.tsx");
const { PrivySolanaProvider, usePrivySolana } = await import("../src/components/providers/privy-provider.tsx");
const { UIProvider } = await import("../src/components/providers/ui-provider.tsx");
function renderPerson(book: NonNullable<ComponentProps<typeof FmpPerson>["initialData"]>) {
  return renderToStaticMarkup(createElement(PrivySolanaProvider, null, createElement(UIProvider, null, createElement(FmpPerson, { id: person.id, initialData: book }))));
}
function renderHome(initialData: { people: StoredPerson[]; total: number; partial: boolean; savedAt: string | null; storage: string }, indexes: PublicVaultDefinition[] = []) {
  const initialIndexes = { count: indexes.length, indexes, publicFundsEnabled: false, storage: "supabase" };
  return renderToStaticMarkup(createElement(PrivySolanaProvider, null, createElement(UIProvider, null, createElement(ConsumerHome, { initialData, initialIndexes }))));
}

const person: StoredPerson = {
  id: "A000001", provider: "fmp", providerId: "A000001", name: "Example Filer",
  firstName: "Example", lastName: "Filer", chamber: "house", position: "Representative",
  party: null, state: "CA", active: true, image: "https://example.com/portrait.jpg",
  bookState: "partial-disclosure-only", publishedIndexHash: null,
};
const directory = Array.from({ length: 540 }, (_, i) => ({ ...person, id: `A${String(i).padStart(6, "0")}`, name: `Example Filer ${i}`, chamber: i % 2 ? "house" as const : "senate" as const }));
const nativeIndex: PublicVaultDefinition = {
  indexId: "insiderindex-example-filer", kind: "person", personSlug: "example-filer", bioguideId: person.id,
  name: "Example F Index", symbol: "IIFILER", status: "CREATABLE", weightBasis: "annual-holding-value-midpoint",
  depositsEnabled: false, depositReason: "public release disabled",
  coverage: { tickerCount: 1, mappedLegCount: 1, mappableByWeightBps: 7500 },
  provenance: { kind: "person", fmpYear: 2025, note: "Annual holdings mapped from public disclosure." },
  legs: [{ ticker: "TEST", provider: "xstock", mint: "test-mint", bookWeightBps: 7500, targetWeightBps: 10000, vaultReady: true }],
  unmapped: [], vaultAddress: null, shareMint: null, updatedAt: "2026-09-16T00:00:00Z",
};

// Assertions below inspect generated HTML, the public render output, not implementation source.
test("home is one index catalog surface without stacked discovery sections", () => {
  const html = renderHome({ people: directory, total: 540, partial: false, savedAt: null, storage: "supabase" });
  assert.match(html, /They disclose it/);
  assert.match(html, /Pick the index\. See the book/);
  assert.match(html, /Built on Solana/);
  assert.doesNotMatch(html, /PEOPLE ARE THE INDEX|THE DIRECTORY|THE TAPE|Show more people/);
  assert.doesNotMatch(html, /Capitol Buys|Form-4 CEO|Sign &amp; buy|Basket Buy/);
});

test("published models use person-index discovery, never legacy crowd baskets", () => {
  const hash = "a".repeat(64);
  const html = renderHome({ people: [{ ...person, publishedIndexHash: hash, indexName: "Example F Index" }], total: 1, partial: true, savedAt: null, storage: "supabase" }, [nativeIndex]);
  assert.match(html, /\/indexes\/insiderindex-example-filer/);
  assert.match(html, /Person index/);
  assert.match(html, /Example F Index/);
  assert.doesNotMatch(html, /Capitol Buys|crowd basket|Sign &amp; buy/);
});

test("unpublished books do not appear in the 20-index catalog", () => {
  const html = renderHome({ people: [{ ...person, indexName: "Example F Index" }], total: 1, partial: true, savedAt: null, storage: "supabase" });
  assert.doesNotMatch(html, /Example Filer|Example F Index|Person index/);
  assert.match(html, /No indexes match this view|Loading index catalog/);
});

test("a failed disclosure tape renders a retryable error instead of an empty tape", () => {
  const html = renderToStaticMarkup(createElement(FilingTape, { disclosures: [], error: "Disclosure service unavailable", retry: () => undefined }));
  assert.match(html, /role="alert"/);
  assert.match(html, /Disclosure service unavailable/);
  assert.match(html, /Try again/);
  assert.doesNotMatch(html, /Nothing new on the tape/);
});

test("a loading disclosure tape does not claim the feed is empty", () => {
  const html = renderToStaticMarkup(createElement(FilingTape, { disclosures: [], error: null, loading: true, retry: () => undefined }));
  assert.match(html, /aria-busy="true"/);
  assert.match(html, /Loading recent disclosures/);
  assert.doesNotMatch(html, /Nothing new on the tape/);
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

test("pool readiness distinguishes absent, thin, and qualifying Raydium liquidity", () => {
  const leg = { ticker: "TEST", mint: "test-mint", issuer: "xstock", weight_bps: 10_000 };
  assert.equal(poolReadinessLabel({ ...leg, pool_status: "none", vault_ready: false }), "No Raydium–USDC pool");
  assert.equal(poolReadinessLabel({ ...leg, pool_status: "thin", pool_tvl_usd: 4200, vault_ready: false }), "Thin pool · $4,200 TVL");
  assert.equal(poolReadinessLabel({ ...leg, pool_status: "observed", pool_tvl_usd: 12_000, vault_ready: true }), "Pool ready");
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
    assert.equal(wallet.previewConnection, false);
    await assert.rejects(wallet.connect(), /unavailable/);
    await assert.rejects(wallet.signTransaction("test-transaction"), /live wallet is required/);
    await assert.rejects(wallet.signTransaction("test-transaction", "devnet"), /fixtures are never accepted/);
    await assert.rejects(wallet.signAndSendTransaction("test-transaction"), /live wallet is required/);
    await assert.rejects(wallet.signAndSendTransaction("test-transaction", "devnet"), /fixtures are never accepted/);
    renderToStaticMarkup(cloneElement(fallback, { pendingLive: true }));
    assert.equal(wallet.ready, false);
    assert.equal(wallet.solanaAddress, null);
    await assert.rejects(wallet.connect(), /still connecting/);
  } finally {
    if (original === undefined) Reflect.deleteProperty(process.env, "NODE_ENV"); else Object.assign(process.env, { NODE_ENV: original });
  }
});
