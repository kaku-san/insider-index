import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { plainSliceReason, sliceHeadline, SLICE_FOOTNOTE, withSliceMarks, type NavSlice } from "../src/lib/frontend/slice-notes.ts";
import { publishedSliceFor, sliceFromPublishedRow, tradableSliceFor, type TradableSlice } from "../src/lib/nav-vault/slices.ts";
import { updatePricesIx } from "../src/lib/nav-vault/program.ts";
import { navVaultConfig } from "../src/lib/nav-vault/config.ts";
import { handleNavReadiness } from "../src/lib/nav-vault/server.ts";
import { navVaultVm, seedIndex, PRICE_A, PRICE_B } from "./support/nav-vault-vm.mts";

register("./support/ui-loader.mjs", import.meta.url);
const { IndexAllocation } = await import("../src/components/index-allocation.tsx");
const { TradableSliceNote } = await import("../src/components/tradable-slice-note.tsx");
const { VaultFlow } = await import("../src/components/vault-flow.tsx");
const { PrivySolanaProvider } = await import("../src/components/providers/privy-provider.tsx");
const { UIProvider } = await import("../src/components/providers/ui-provider.tsx");

const pelosi = tradableSliceFor("insiderindex-nancy-pelosi")!;
/** The readiness `slice` shape the NAV route returns for a matching vault. */
const navSlice = (slice: TradableSlice): NavSlice => ({
  tradableLegs: slice.tradableLegs, totalLegs: slice.totalLegs, disclosedWeightBps: slice.disclosedWeightBps,
  vaultLegs: slice.vaultLegs.map(leg => ({ ticker: leg.ticker, mint: leg.mint, disclosedWeightBps: leg.disclosedWeightBps, targetWeightBps: leg.targetWeightBps })),
  excluded: slice.excluded.map(item => ({ ticker: item.ticker, mint: item.mint, disclosedWeightBps: item.disclosedWeightBps, reason: item.reason })),
});
/** The disclosed book as the Allocation tab receives it (every held + excluded name, disclosed weights). */
const disclosedItems = (slice: TradableSlice) => [...slice.vaultLegs, ...slice.excluded]
  .map(leg => ({ ticker: leg.ticker, weightBps: leg.disclosedWeightBps, mint: leg.mint, network: "mainnet-beta" }));
const count = (html: string, pattern: RegExp) => (html.match(pattern) ?? []).length;

test("scan reasons become plain English; every committed reason maps to a customer sentence", () => {
  assert.equal(plainSliceReason("no Jupiter or Raydium route"), "No tradable liquidity on Solana yet");
  assert.equal(plainSliceReason("no route at $10 or $100"), "No tradable liquidity on Solana yet");
  assert.equal(plainSliceReason("price moves 55.2% between a $10 and a $100 buy"), "Market too thin right now");
  assert.equal(plainSliceReason("not scanned"), "Liquidity not checked yet");
  const document = JSON.parse(readFileSync(new URL("../src/lib/nav-vault/tradable-slices.json", import.meta.url), "utf8")) as { slices: TradableSlice[] };
  for (const reason of new Set(document.slices.flatMap(slice => slice.excluded.map(item => item.reason)))) {
    assert.match(plainSliceReason(reason), /^(No tradable liquidity on Solana yet|Market too thin right now)$/, reason);
  }
  assert.equal(SLICE_FOOTNOTE, "*Not held in the vault yet. Added as soon as trading volume and liquidity improve.");
});

test("slice marks: held rows get the vault target, excluded rows stay listed with a reason, no slice leaves rows untouched", () => {
  const slice: NavSlice = { tradableLegs: 1, totalLegs: 3, disclosedWeightBps: 6000, vaultLegs: [{ ticker: "AAA", mint: "mint-a", disclosedWeightBps: 6000, targetWeightBps: 10000 }],
    excluded: [{ ticker: "BBB", mint: "mint-b", disclosedWeightBps: 3000, reason: "no Jupiter or Raydium route" }, { ticker: "CCC", mint: "mint-c", disclosedWeightBps: 1000, reason: "price moves 14.3% between a $10 and a $100 buy" }] };
  const items = [{ ticker: "AAA", weightBps: 6000, mint: "mint-a" }, { ticker: "bbb", weightBps: 3000 }];
  const marked = withSliceMarks(items, slice);
  assert.deepEqual(marked.map(item => item.sliceMark), [
    { held: true, targetWeightBps: 10000 },
    { held: false, reason: "No tradable liquidity on Solana yet", disclosedWeightBps: 3000 },
    { held: false, reason: "Market too thin right now", disclosedWeightBps: 1000 },
  ]);
  assert.equal(marked[2].ticker, "CCC", "an excluded name missing from the source rows is still listed");
  assert.ok(Number.isNaN(marked[2].weightBps), "an appended name never re-draws the chart");
  assert.equal(withSliceMarks(items, null), items);
  assert.equal(withSliceMarks(items, { ...slice, totalLegs: null }), items, "unknown totals: no slice claims");
});

test("published slice table wins; unreachable, empty or malformed rows fall back to the committed JSON", async () => {
  const row = { index_id: "insiderindex-nancy-pelosi", total_legs: 2, tradable_legs: 1, disclosed_weight_bps: 5000,
    vault_legs: [{ ticker: "NVDA", mint: "mint-n", disclosedWeightBps: 5000, targetWeightBps: 10000 }],
    excluded: [{ ticker: "NEW", mint: "mint-x", disclosedWeightBps: 5000, reason: "no Jupiter or Raydium route" }] };
  const rpc = (data: unknown, error: unknown = null) => async () => ({ data, error });
  const published = await publishedSliceFor("insiderindex-nancy-pelosi", rpc(row));
  assert.equal(published?.totalLegs, 2);
  assert.deepEqual(published?.excluded.map(item => item.ticker), ["NEW"]);
  for (const fallback of [rpc(null), rpc(row, { code: "42P01" }), rpc({ ...row, excluded: "bad" }), rpc({ ...row, index_id: "other" }), async () => { throw new Error("down"); }, null]) {
    assert.deepEqual(await publishedSliceFor("insiderindex-nancy-pelosi", fallback), pelosi);
  }
  assert.equal(sliceFromPublishedRow({ ...row, tradable_legs: 2 }, "insiderindex-nancy-pelosi"), null, "leg count must match the published vault legs");
  assert.equal(sliceFromPublishedRow({ ...row, total_legs: 3 }, "insiderindex-nancy-pelosi"), null, "every disclosed holding must be classified");
  assert.equal(sliceFromPublishedRow({ ...row, excluded: [{ ...row.excluded[0], mint: "mint-n" }] }, "insiderindex-nancy-pelosi"), null, "a mint cannot appear twice");
  assert.equal(sliceFromPublishedRow({ ...row, disclosed_weight_bps: 9000 }, "insiderindex-nancy-pelosi"), null, "published coverage must equal the held legs' disclosed weight");
  assert.equal(sliceFromPublishedRow({ ...row, excluded: [{ ...row.excluded[0], disclosedWeightBps: 100 }] }, "insiderindex-nancy-pelosi"), null, "held and excluded disclosed weights must describe the complete book");
});

test("a stale published slice falls back to a committed slice matching the vault", async () => {
  const row = { index_id: pelosi.indexId, total_legs: 2, tradable_legs: 1, disclosed_weight_bps: 5000,
    vault_legs: [{ ticker: "OLD", mint: "stale-mint", disclosedWeightBps: 5000, targetWeightBps: 10000 }],
    excluded: [{ ticker: "NEW", mint: "excluded-mint", disclosedWeightBps: 5000, reason: "no Jupiter or Raydium route" }] };
  const vaultMints = new Set(pelosi.vaultLegs.map(leg => leg.mint));
  const matchesVault = (slice: TradableSlice) => slice.vaultLegs.length === vaultMints.size && slice.vaultLegs.every(leg => vaultMints.has(leg.mint));
  assert.deepEqual(await publishedSliceFor(pelosi.indexId, async () => ({ data: row, error: null }), matchesVault), pelosi);
});

test("readiness carries the vault target for held names and the disclosed weight + reason for excluded names", async () => {
  const vm = navVaultVm();
  const s = seedIndex(vm, "insiderindex-slice-test");
  vm.must(vm.send([updatePricesIx(vm.vault(s.indexId), s.keeper.publicKey, [PRICE_A, PRICE_B])], s.keeper));
  vm.advance(1);
  const slice: TradableSlice = { indexId: s.indexId, totalLegs: 3, tradableLegs: 2, disclosedWeightBps: 8000, eligible: true,
    vaultLegs: [{ ticker: "AAA", mint: s.legA.toBase58(), disclosedWeightBps: 5000, targetWeightBps: 1 }, { ticker: "BBB", mint: s.legB.toBase58(), disclosedWeightBps: 3000, targetWeightBps: 1 }],
    excluded: [{ ticker: "CCC", mint: "mint-c", disclosedWeightBps: 2000, reason: "no Jupiter or Raydium route" }] };
  const readiness = await (await handleNavReadiness(s.indexId, {
    config: () => navVaultConfig({ STOCKLANA_NAV_VAULT_INDEXES: s.indexId, STOCKLANA_NAV_VAULT_NETWORK: "devnet" }),
    connection: () => vm.connection, now: () => Number(vm.svm.getClock().unixTimestamp), slice: async () => slice,
  })).json();
  assert.equal(sliceHeadline(readiness.slice), "Tradable slice: 2 of 3 holdings (80.0% of disclosed weight)");
  assert.deepEqual(readiness.slice.vaultLegs.map((leg: { ticker: string; targetWeightBps: number }) => [leg.ticker, leg.targetWeightBps]), [["AAA", 6000], ["BBB", 4000]], "held weights are the on-chain targets");
  assert.deepEqual(readiness.slice.excluded, [{ ticker: "CCC", mint: "mint-c", disclosedWeightBps: 2000, reason: "no Jupiter or Raydium route" }]);
});

test("Allocation tab: headline, every excluded name asterisked with its reason, labeled weights, one footnote", () => {
  const html = renderToStaticMarkup(createElement(IndexAllocation, { items: disclosedItems(pelosi), slice: navSlice(pelosi) }));
  assert.match(html, /Tradable slice: 5 of 18 holdings \(72\.6% of disclosed weight\)/);
  assert.match(html, /Disclosed weight/);
  for (const item of pelosi.excluded) assert.ok(html.includes(`${item.ticker}<sup`), `${item.ticker} is listed with an asterisk even while the legend is collapsed`);
  assert.equal(count(html, /data-slice-excluded="true"/g), pelosi.excluded.length);
  assert.equal(count(html, /data-slice-held="true"/g), pelosi.vaultLegs.filter(leg => html.includes(`>${leg.ticker}<`)).length);
  for (const leg of pelosi.vaultLegs) if (html.includes(`>${leg.ticker}<`)) assert.ok(html.includes(`vault target ${(leg.targetWeightBps / 100).toFixed(leg.targetWeightBps >= 1000 ? 1 : 2)}%`), leg.ticker);
  assert.match(html, /\*No tradable liquidity on Solana yet/);
  const other = html.match(/Other holdings<\/strong><small>(\d+) holdings[^<]*<\/small>[\s\S]*?<b>([\d.]+)%<\/b>/);
  const individuallyShownWeight = [...html.matchAll(/data-slice-(?:held|excluded)="true"[^<]*<\/span>[\s\S]*?<b>([\d.]+)%<\/b>/g)].reduce((sum, match) => sum + Number(match[1]), 0);
  assert.ok(other, "the collapsed legend keeps a residual Other holdings row");
  assert.equal(Number(other[2]) + individuallyShownWeight, 100, "Other holdings excludes every individually shown slice row");
  assert.match(html, new RegExp(`Other holdings: ${Number(other[2]).toFixed(2)}%`), "the chart uses the same residual Other holdings weight");
  assert.equal(count(html, /Not held in the vault yet\. Added as soon as trading volume and liquidity improve\./g), 1);
  const plain = renderToStaticMarkup(createElement(IndexAllocation, { items: disclosedItems(pelosi) }));
  assert.doesNotMatch(plain, /Tradable slice|Not held in the vault|<sup|vault target/, "no NAV vault: no slice notes");
});

test("hero note and invest sheet repeat the asterisked names, plain reasons and footnote", () => {
  const readiness = { indexId: pelosi.indexId, kind: "nav-vault" as const, depositEnabled: true, redeemEnabled: true, slice: navSlice(pelosi) };
  const note = renderToStaticMarkup(createElement(TradableSliceNote, { readiness }));
  assert.match(note, /13 disclosed names are not held yet\*/);
  for (const item of pelosi.excluded) assert.ok(note.includes(`${item.ticker}* — ${plainSliceReason(item.reason)}`), item.ticker);
  assert.ok(note.includes(SLICE_FOOTNOTE));
  const sheet = renderToStaticMarkup(createElement(UIProvider, null, createElement(PrivySolanaProvider, null, createElement(VaultFlow, {
    open: true, onClose() {}, indexId: pelosi.indexId, indexName: "Nancy Pelosi", readiness,
  }))));
  assert.match(sheet, /Tradable slice: 5 of 18 holdings/);
  assert.match(sheet, /Not held yet\*/);
  for (const item of pelosi.excluded) assert.ok(sheet.includes(`${item.ticker}*`), item.ticker);
  assert.equal(count(sheet, /Not held in the vault yet\. Added as soon as trading volume and liquidity improve\./g), 1);
});
