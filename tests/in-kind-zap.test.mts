import assert from "node:assert/strict";
import test from "node:test";
import { PublicKey } from "@solana/web3.js";
import {
  attributeSwapDeltas, contributionsFromObservation, discloseInKindRounding, inKindMintDecision, observeAcquisition,
  planInKindZap, planWeightedUsdcSlices, quoteInKindSlices, unroutableLegMessage, zapStatusLine,
} from "../src/lib/index-vaults/in-kind-zap.ts";
import { MAINNET_USDC } from "../src/lib/index-vaults/native-defaults.ts";
import { WSOL_MINT } from "../src/lib/index-vaults/raydium-oracles.ts";

const ASTRA = [
  ["MSFT", 3448, "3448000"],
  ["AAPL", 2740, "2740000"],
  ["AMZN", 1151, "1151000"],
  ["GOOGL", 1424, "1424000"],
  ["NVDA", 854, "854000"],
  ["META", 322, "322000"],
  ["TSLA", 61, "61000"],
] as const;

function legs(rows: readonly (readonly [string, number, string?])[] = ASTRA) {
  return rows.map(([ticker, targetWeightBps]) => ({ mint: PublicKey.unique().toBase58(), ticker, targetWeightBps }));
}

function quotesFor(rows: ReturnType<typeof legs>, venue: "jupiter" | "raydium" = "jupiter") {
  return rows.map(leg => ({ mint: leg.mint, ticker: leg.ticker, venue, usdcInRaw: (10_000_000n * BigInt(leg.targetWeightBps) / 10_000n).toString(), expectedOutRaw: "5", minOutRaw: "4" }));
}

test("Astra $10/$20/$30 Mag7 weights split user USDC and leave rounding dust unspent", () => {
  const book = legs();
  for (const dollars of [10, 20, 30]) {
    const planned = planWeightedUsdcSlices(String(dollars * 1_000_000), book);
    assert.equal(planned.slices.map(slice => slice.usdcInRaw).join(","), ASTRA.map(([, , raw]) => (BigInt(raw!) * BigInt(dollars) / 10n).toString()).join(","));
    assert.equal(planned.leftoverUsdcRaw, "0");
    assert.equal(planned.slices.at(-1)?.ticker, "TSLA");
    assert.notEqual(planned.slices.at(-1)?.usdcInRaw, "0");
  }
  const dust = planWeightedUsdcSlices("10000001", book);
  assert.equal(dust.leftoverUsdcRaw, "1");
  assert.equal(dust.allocatedUsdcRaw, "10000000");
});

test("a missing quote refuses before any spend and never plans keeper USDC or auction pairs", () => {
  const book = legs();
  assert.throws(() => planInKindZap({ indexId: "idx-theme-mag7-caucus", amountRaw: "10000000", legs: book, quotes: quotesFor(book).slice(0, 6) }), /cannot buy Mag7/);
  const other = legs([["AAA", 5000], ["BBB", 5000]]);
  assert.equal(unroutableLegMessage("idx-theme-other", "BBB"), "This amount cannot buy BBB right now.");
  assert.throws(() => planInKindZap({ indexId: "idx-theme-other", amountRaw: "10000000", legs: other, quotes: [] }), /cannot buy/);
  const plan = planInKindZap({ indexId: "idx-theme-other", amountRaw: "10000000", legs: other, quotes: quotesFor(other), atomicBytes: 2000 });
  assert.equal(plan.keeperUsdcRaw, "0");
  assert.equal(plan.usesAuctionPairs, false);
  assert.equal(plan.packaging, "resumable");
  assert.equal(planInKindZap({ indexId: "idx-theme-other", amountRaw: "10000000", legs: other, quotes: quotesFor(other, "raydium"), atomicBytes: 800 }).packaging, "atomic");
  assert.equal(plan.venues.join(","), "jupiter");
});

test("partial buys are not claimed as the full basket", () => {
  const book = legs();
  const acquired = Object.fromEntries(book.map((leg, index) => [leg.mint, index < 2 ? "4" : "0"]));
  const observed = observeAcquisition({
    legs: book, acquiredRawByMint: acquired, minimumRawByMint: Object.fromEntries(book.map(leg => [leg.mint, "4"])), leftoverUsdcRaw: "61000",
  });
  assert.equal(observed.complete, false);
  assert.equal(observed.claimCount, null);
  assert.equal(observed.bought.length, 2);
  assert.match(observed.statusLine, /2 of 7/);
  assert.match(observed.statusLine, /Not bought: AMZN/);
  assert.doesNotMatch(observed.statusLine, /Bought MSFT, AAPL, AMZN, GOOGL, NVDA, META, TSLA/);
  assert.throws(() => contributionsFromObservation(observed), /IN_KIND_INCOMPLETE/);
  assert.equal(zapStatusLine({ targetCount: 3, bought: [], missing: [{ ticker: "A" }], complete: false }), "Bought none of 3 names. Shares were not minted.");
});

test("a complete basket contributes tokens, not USDC, and mints only when every leg is present", () => {
  const book = legs([["AAA", 5000], ["BBB", 5000]]);
  const observed = observeAcquisition({
    legs: book, acquiredRawByMint: { [book[0]!.mint]: "9", [book[1]!.mint]: "8" }, minimumRawByMint: { [book[0]!.mint]: "4", [book[1]!.mint]: "4" }, leftoverUsdcRaw: "0",
  });
  assert.equal(observed.claimCount, 2);
  assert.deepEqual(contributionsFromObservation(observed).map(row => row.mint), book.map(leg => leg.mint));
  assert.equal(contributionsFromObservation(observed).some(row => row.mint === MAINNET_USDC), false);
  const tokens = book.map(leg => ({ mint: leg.mint, amount: "1" }));
  assert.equal(inKindMintDecision({ legs: book, tokens, wsolMint: WSOL_MINT }).mint, true);
  assert.equal(inKindMintDecision({ legs: book, tokens: tokens.slice(0, 1), wsolMint: WSOL_MINT }).reason, "incomplete-basket");
  assert.equal(inKindMintDecision({ legs: book, tokens: [], wsolMint: WSOL_MINT }).reason, "empty-book");
  assert.equal(inKindMintDecision({ legs: book, tokens: [...tokens, { mint: WSOL_MINT, amount: "1" }], wsolMint: WSOL_MINT }).reason, "support-unreconciled");
});

test("Jupiter is quoted before Raydium, and a failed Jupiter route may fall back without an auction pair", async () => {
  const book = legs([["AAA", 5000], ["BBB", 5000]]);
  const calls: string[] = [];
  const quoted = await quoteInKindSlices({
    indexId: "idx-theme-other", amountRaw: "10000000", legs: book,
    jupiter: async slice => { calls.push(`jup:${slice.ticker}`); return slice.ticker === "AAA" ? { mint: slice.mint, venue: "jupiter", expectedOutRaw: "5", minOutRaw: "4" } : null; },
    raydium: async slice => { calls.push(`ray:${slice.ticker}`); return { mint: slice.mint, venue: "raydium", expectedOutRaw: "3", minOutRaw: "2" }; },
  });
  assert.deepEqual(calls, ["jup:AAA", "jup:BBB", "ray:BBB"]);
  assert.deepEqual(quoted.plan.venues, ["jupiter", "raydium"]);
  assert.equal(quoted.plan.usesAuctionPairs, false);
  await assert.rejects(quoteInKindSlices({
    indexId: "idx-theme-other", amountRaw: "10000000", legs: book,
    jupiter: async () => null,
    raydium: async () => null,
  }), /cannot buy AAA/);
});

test("swap deltas attribute only the user's buys and reject a replay", () => {
  const book = legs([["AAA", 10000]]);
  const signature = "sig-1";
  const deltas = attributeSwapDeltas({
    owner: "owner", legs: book, usdcMint: "USDC",
    signatures: [{ signature, pre: [{ mint: "USDC", owner: "owner", amountRaw: "100" }, { mint: book[0]!.mint, owner: "owner", amountRaw: "0" }], post: [{ mint: "USDC", owner: "owner", amountRaw: "40" }, { mint: book[0]!.mint, owner: "owner", amountRaw: "7" }] }],
  });
  assert.equal(deltas.usdcSpentRaw, "60");
  assert.equal(deltas.acquiredRawByMint[book[0]!.mint], "7");
  assert.throws(() => attributeSwapDeltas({ owner: "owner", legs: book, signatures: [{ signature, pre: [], post: [] }, { signature, pre: [], post: [] }] }), /REPLAY/);
});

test("share rounding is disclosed and a bootstrap owner is not treated as a lost dollar", () => {
  const first = discloseInKindRounding({ beforeSupply: "0", grossMinted: "9", beforeValueQ: 0n, contributedValueQ: 9_978_221n, usdcPriceQ: 1_000_000n });
  assert.equal(first.lossUsdcRaw, "0");
  assert.equal(first.exactContinuousProportions, false);
  const second = discloseInKindRounding({ beforeSupply: "9", grossMinted: "8", beforeValueQ: 9_978_221n, contributedValueQ: 9_978_189n, usdcPriceQ: 1_000_000n });
  assert.notEqual(second.lossUsdcRaw, "0");
  assert.equal(second.disclosed, true);
});
