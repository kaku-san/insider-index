import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { readFileSync } from "node:fs";
import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { indexCatalog, type CatalogToken } from "../src/lib/venues/catalog-parse.ts";
import { normalizeTrackerHandoff } from "../src/lib/tracker/tracker-parse.ts";
import { buildTrackerPersonView } from "../src/lib/tracker/views.ts";

register("./support/ui-loader.mjs", import.meta.url);
const { FmpPerson } = await import("../src/components/fmp-portfolio.tsx");
const { TrackerIndex } = await import("../src/components/tracker-index.tsx");
const { TrackerShelf } = await import("../src/components/tracker-shelf.tsx");
const { TrackerLedger } = await import("../src/components/tracker-portfolio.tsx");
const { PrivySolanaProvider } = await import("../src/components/providers/privy-provider.tsx");
const { UIProvider } = await import("../src/components/providers/ui-provider.tsx");
type Portfolio = NonNullable<ComponentProps<typeof FmpPerson>["initialData"]>;

const brief = JSON.parse(readFileSync(new URL("../data/insiderindex-source-buckets/pelositracker-top20rere-handoff/top20-agent-brief.json", import.meta.url), "utf8"));
const handoff = normalizeTrackerHandoff(brief);
const catalogSnapshot = JSON.parse(readFileSync(new URL("../src/lib/venues/catalog-snapshot.json", import.meta.url), "utf8")) as { xstocks: CatalogToken[]; backpack: CatalogToken[] };
const catalog = { ...indexCatalog([...catalogSnapshot.xstocks, ...catalogSnapshot.backpack]), feeds: [] };
const pelosiView = buildTrackerPersonView(handoff.profiles[0], catalog, "Nancy P Index");
const person = { id: "P000197", name: "Nancy Pelosi", firstName: "Nancy", lastName: "Pelosi", chamber: "house", state: "CA", party: "Democrat", image: null };
const annualItem = (id: string, name: string, kind: string, low: number, high: number) => ({ id, name, ticker: null, kind, owner: "Spouse", valueRange: { low, high }, incomeRange: { low: null, high: null }, mappingReason: null, token: null });
const book: Portfolio = {
  person, indexName: "Nancy P Index", savedAt: "2026-09-14T16:09:54.104Z", state: "partial-disclosure-only", activity: [],
  snapshots: [{ id: "filing-2024", year: 2024, filingDate: "2025-05-15", sourceUrl: null, complete: false, issues: ["partial-ingestion"], items: [
    annualItem("a1", "NVIDIA Corporation - Common Stock (NVDA) [ST]", "stock", 5000001, 25000000),
    annualItem("a2", "Apple Inc. (AAPL) [ST]", "stock", 25000001, 50000000),
    annualItem("a3", "Union Bank of California", "liability", 1000001, 5000000),
  ] }],
  publishedIndex: { hash: "c".repeat(64), person_id: "P000197", period: "2024-12-31", version: 1, published_at: "2026-09-14T17:00:00Z", definition: { label: "Latest saved annual holdings", methodology: "holding-band-midpoints", snapshotComplete: false, evidence: [{ holding: { id: "a1" }, ticker: "NVDA", token: { issuer: "xstock", symbol: "NVDAx", mint: "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh" }, method: "fmp-exact-name", reason: null }] }, constituents: [{ ticker: "AAPL", mint: "m-aapl", issuer: "xstock", weight_bps: 7143, payload: { evidencedMidpoint: 37500000.5 } }, { ticker: "NVDA", mint: "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh", issuer: "xstock", weight_bps: 2857, payload: { evidencedMidpoint: 15000000.5 } }] },
} as unknown as Portfolio;
const render = (element: React.ReactElement) => renderToStaticMarkup(createElement(UIProvider, null, createElement(PrivySolanaProvider, null, element)));

test("the tracker-first person page labels every tracker figure PelosiTracker · Sep 15, 2026, shows trades as info, and keeps FMP as the older annual filing", () => {
  const html = render(createElement(FmpPerson, { id: "P000197", initialData: book, tracker: pelosiView }));
  assert.match(html, /<h1>Nancy P Index · Tracker positions<\/h1>/);
  assert.match(html, /src="\/tracker\/photos\/nancy-pelosi\.jpg"/);
  assert.ok((html.match(/PelosiTracker · as of Sep 15, 2026/g) ?? []).length >= 6, "every tracker section carries the source and scrape date");
  assert.match(html, /PelosiTracker portfolio value<\/dt><dd>\$312\.1M<\/dd><small>Politician-API third-party estimate as of Sep 15, 2026\. Not net worth, not a vault NAV, and not the copy-trade book \(\$23\.2M\)/);
  assert.match(html, /PelosiTracker 30-day change<\/dt><dd data-tone="negative">-3\.03%/);
  // Shown book: tracker positions first with their percentage, then the older annual rows.
  const shown = html.slice(html.indexOf('id="shown-book-title"'), html.indexOf('id="tracker-index-title"'));
  assert.match(shown, /Current positions · shown book/);
  assert.match(shown, /copy-trade book/);
  assert.match(shown, /never one total|never added together/);
  assert.match(shown, /15\.16%/);
  assert.match(shown, /copy-trade MTM/);
  assert.match(shown, /NVDA<\/strong>/);
  assert.match(shown, /GOOGL<\/strong>/);
  assert.match(shown, /VST<\/strong>/);
  assert.match(shown, /Union Bank of California/);
  assert.match(shown, /Tracker Sep 15, 2026 \+ annual filing/);
  assert.match(shown, /FMP annual filing · 2024-12-31/);
  assert.doesNotMatch(shown, /Total portfolio|Combined value|\$0<\/strong>/);
  // Vault-ready index: weights from positions, GOOG excluded with a reason, trades never used, funds disabled.
  const index = html.slice(html.indexOf('id="tracker-index-title"'), html.indexOf('id="compare-title"'));
  assert.match(index, /first live candidate|Wait readiness/);
  assert.match(index, /IBTA\.L/);
  assert.match(index, /no solana mint/);
  assert.match(index, /10,000 bps|No investable slice yet/);
  assert.match(index, /trades not used/);
  assert.match(index, /Public funds remain disabled \(WAIT_FULL_CYCLE_RECEIPT\)/);
  assert.match(index, /href="\/indexes\/tracker-P000197"/);
  // FMP comparison on the same bioguide: both sides present.
  const compare = html.slice(html.indexOf('id="compare-title"'), html.indexOf('id="sectors-title"'));
  assert.match(compare, /FMP target · annual 2024-12-31/);
  assert.match(compare, /NVDA<\/strong>.*?Both.*?15\.16%/s);
  assert.match(compare, /AAPL<\/strong>.*?Both/s);
  assert.match(compare, /href="\/indexes\/fmp-c{64}"/);
  // Sectors, trades (info only, decoded bands), filing stats, series.
  assert.match(html, /Technology<\/span>.*?67\.21%/s);
  assert.match(html, /Uninvested cash/);
  const trades = html.slice(html.indexOf('id="tracker-trades-title"'), html.indexOf('id="tracker-ledger-title"'));
  assert.match(html, /Transaction ledger · information only/);
  assert.match(html, /49 unique tickers traded across 921 ledger lines/);
  assert.match(html, /Tickers traded:/);
  assert.match(trades, /Recent trades · information only/);
  assert.match(trades, /never an input to any index weight/);
  assert.match(trades, /BE<\/strong>/);
  assert.match(trades, /\$500,001–\$1,000,000/);
  assert.match(trades, /\$1,000,001–\$5,000,000/);
  assert.match(trades, /Jul 28, 2026/);
  assert.match(trades, /Filing status: New/);
  assert.equal((trades.match(/data-side="buy"/g) ?? []).length, 10);
  assert.match(html, /Total filings<\/dt><dd>65<\/dd>/);
  assert.match(html, /Total transactions<\/dt><dd>921<\/dd>/);
  assert.match(html, /2,426 daily points/);
  assert.match(html, /Latest tracker estimate <strong>\$312,070,255<\/strong>/);
  assert.match(html, /125 leading zero-value points/);
  assert.match(html, /draws no S&amp;P 500 overlay/);
  assert.doesNotMatch(html, /Historical simulation|\+[0-9.]+% since/);
  // FMP sections still render below, labelled as the older annual disclosure.
  assert.match(html, /Older annual disclosure · FMP/);
  assert.match(html, /not 2026 holdings/);
  assert.match(html, /Disclosed book · annual filing/);
  assert.match(html, /Saved FMP trade history/);
  // Invest stays disabled everywhere.
  assert.match(html, /disabled="" aria-describedby="invest-blocker">Basket buying unavailable/);
  assert.doesNotMatch(html, /Invest now|Sign to invest|Deposit USDC/);
});

test("a tracker person with no saved FMP book still renders every tracker section and says so", () => {
  const greene = handoff.profiles.find((p) => p.id === "G000596")!;
  const view = buildTrackerPersonView(greene, catalog);
  // No FMP initialData: the tracker sections render on their own; the shown book and comparison say no FMP book exists.
  const html = render(createElement(FmpPerson, { id: "G000596", initialData: undefined, tracker: view }));
  assert.match(html, /<h1>Marjorie G Index · Tracker positions<\/h1>/);
  assert.match(html, /Former member/);
  assert.match(html, /2021 - 2026/);
  assert.match(html, /No saved FMP annual book exists for this person/);
  assert.match(html, /Not in saved FMP directory|No FMP index published/);
  assert.match(html, /AMD<\/strong>/);
  assert.match(html, /IBIT<\/strong>/);
  assert.match(html, /copy-trade book/);
  assert.equal(greene.topHoldings.length, 76);
  assert.doesNotMatch(html, /Older annual disclosure · FMP/);
});

test("Senate rows show tracker coverage gaps honestly instead of zero filings", () => {
  const scott = handoff.profiles.find((p) => p.id === "S001217")!;
  const html = render(createElement(FmpPerson, { id: "S001217", tracker: buildTrackerPersonView(scott, catalog) }));
  assert.match(html, /Not tracked by PelosiTracker for this member/);
  assert.doesNotMatch(html, /Total filings<\/dt><dd>0<\/dd>/);
  assert.match(html, /GLDM<\/strong>/);
  assert.match(html, /Unitemized OTHER|OTHER \(not itemized/);
  assert.match(html, /No tickers invented|No investable slice yet/);
});

test("the tracker index page shows proportions with mint and pool addresses and a disabled invest rail", () => {
  const html = render(createElement(TrackerIndex, { personId: "P000197", initialData: pelosiView, fmpIndexHash: "c".repeat(64) }));
  assert.match(html, /<h1>Nancy P Index · Tracker positions<\/h1>/);
  assert.match(html, /PelosiTracker positions as of Sep 15, 2026/);
  assert.match(html, /10,000 bps|No tracker position has both/);
  assert.match(html, /Proportions, not a NAV\./);
  assert.match(html, /copy-trade portfolio|xStock preferred|Backpack/);
  assert.match(html, /First live candidate|Research the target/);
  assert.match(html, /disabled="" aria-describedby="invest-blocker">Invest unavailable/);
  assert.match(html, /never an input/);
  assert.match(html, /Exit is USDC only: holders never receive a bag of xStocks, and in-kind redemption is not the product/);
  assert.match(html, /host exit fee 0 bps; native USDC exit verified: no/);
  assert.match(html, /href="\/indexes\/fmp-c{64}"/);
  assert.doesNotMatch(html, /314,903,941|\$314\.9M|Redeem in kind|receive xStocks/);
});

test("a member with a large filings ledger renders only one bounded page of rows, not the full unpaginated table", () => {
  const gottheimer = handoff.profiles.find((p) => p.id === "G000583")!;
  assert.ok(gottheimer.ledger.length > 3000, `expected a large ledger, got ${gottheimer.ledger.length}`);
  const html = render(createElement(TrackerLedger, { profile: gottheimer }));
  const bodyRowCount = (html.match(/<tbody>[\s\S]*<\/tbody>/)?.[0].match(/<tr>/g) ?? []).length;
  assert.equal(bodyRowCount, 50, `first page must render exactly 50 body rows, got ${bodyRowCount} for a ${gottheimer.ledger.length}-row ledger`);
  assert.match(html, new RegExp(`Rows 1–50 of ${gottheimer.ledger.length.toLocaleString("en-US")} · page 1 of ${Math.ceil(gottheimer.ledger.length / 50)}`));
  assert.match(html, /<button type="button"[^>]*disabled="">Previous<\/button>/);
  assert.match(html, /<button type="button"[^>]*>Next<\/button>/);
  assert.doesNotMatch(html, /<button type="button"[^>]*disabled=""[^>]*>Next<\/button>/);
});

test("a member with a short ledger shows every row and no pager", () => {
  const short = handoff.profiles.find((p) => p.ledger.length > 0 && p.ledger.length <= 50)!;
  const html = render(createElement(TrackerLedger, { profile: short }));
  const bodyRowCount = (html.match(/<tbody>[\s\S]*<\/tbody>/)?.[0].match(/<tr>/g) ?? []).length;
  assert.equal(bodyRowCount, short.ledger.length);
  assert.doesNotMatch(html, /Transaction ledger pages/);
});

test("the home shelf lists all 20 handoff people with photos, tracker value labels and both links", () => {
  const people = handoff.profiles.map((profile) => {
    const view = buildTrackerPersonView(profile, catalog);
    return { rank: profile.rank, slug: profile.slug, id: profile.id, name: profile.name, title: profile.title, party: profile.party, state: profile.state, chamber: profile.chamber, currentMember: profile.currentMember, photo: profile.photo, asOf: profile.asOf, sourceLabel: profile.sourceLabel, sourceUrl: profile.sourceUrl, portfolioValueUsd: profile.portfolio.valueUsd, portfolioValueLabel: profile.portfolio.label, monthlyChangePercent: profile.portfolio.monthlyChangePercent, topTickers: profile.topHoldings.map((h) => h.ticker), tradesListed: profile.recentTrades.length, holdingsListed: profile.topHoldings.length, index: { id: view.index.id, indexName: view.index.indexName, readiness: view.index.readiness, constituents: view.index.constituents.length } };
  });
  const directory = { source: "pelositracker.app", sourceLabel: "PelosiTracker", asOf: "2026-09-15", scrapedAt: handoff.scrapedAt, selection: handoff.selection, count: 20, partyMix: handoff.partyMix, issues: [], people, poolSnapshot: pelosiView.poolSnapshot, catalog: [], release: pelosiView.release } as unknown as ComponentProps<typeof TrackerShelf>["initialData"];
  const html = renderToStaticMarkup(createElement(TrackerShelf, { initialData: directory }));
  assert.equal((html.match(/href="\/p\/[A-Z][0-9]{6}"/g) ?? []).length, 20);
  assert.equal((html.match(/href="\/indexes\/tracker-[A-Z][0-9]{6}"/g) ?? []).length, 20);
  assert.equal((html.match(/src="\/tracker\/photos\//g) ?? []).length, 20);
  const candidates = people.filter((p) => p.index.readiness.status === "VAULT_CANDIDATE").length;
  assert.ok(candidates >= 5 && candidates < 20, `${candidates} candidates from the committed snapshots`);
  assert.match(html, new RegExp(`20 people · ${candidates} vault candidates`));
  assert.match(html, /Tracker value · Sep 15, 2026/);
  assert.match(html, /not net worth and not a vault NAV/);
  const pelosiShelf = people.find((p) => p.id === "P000197")!;
  assert.match(html, new RegExp(`${pelosiShelf.index.readiness.status === "VAULT_CANDIDATE" ? `Vault candidate · ${pelosiShelf.index.constituents} names · first live` : "Wait readiness"}`));
  assert.match(html, /Ted Budd/);
});
