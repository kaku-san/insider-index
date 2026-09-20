import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register("./support/ui-loader.mjs", import.meta.url);
const { creditHasRemainingAmount, depositIsEnabled, publicVaultDepositIsEnabled, uiStateFrom, validatePreparedStep, vaultReadinessFromIndex } = await import("../src/lib/frontend/vault-api.ts");
const { markedDollars, moneyBand, stockActBandFromMidpoint } = await import("../src/lib/frontend/research-format.ts");

const owner = "Jh7cFNUT5FrtBwKakApsc3Gg5aTQjsZtYxa4dbrCoB8";
function preparedPayload(requires: "user-signature" | "wait" = "user-signature") {
  return {
    operationId: "operation-1",
    phase: "AWAITING_SIGNATURE",
    requires,
    configHash: "config-hash",
    constraints: [],
    blockers: [],
    transactions: requires === "user-signature" ? [{ stepId: "deposit-contribution" }] : [],
  };
}

test("native wallet signing fails closed without semantic instruction validation", async () => {
  await assert.rejects(validatePreparedStep(preparedPayload(), { owner, network: "devnet" }), /signing is unavailable/);
  const wait = await validatePreparedStep(preparedPayload("wait"), { owner, network: "devnet" });
  assert.equal(wait.network, "devnet");
});

test("remaining redeemed credits retain integer precision", () => {
  assert.equal(creditHasRemainingAmount({ creditedRaw: "9007199254740993", soldRaw: "9007199254740992" }), true);
  assert.equal(creditHasRemainingAmount({ creditedRaw: "9007199254740992", soldRaw: "9007199254740992" }), false);
  assert.equal(creditHasRemainingAmount({ creditedRaw: "not-raw", soldRaw: "0" }), false);
});

test("unavailable marked values never render as zero", () => {
  assert.equal(markedDollars(null), "—");
  assert.equal(markedDollars(""), "—");
  assert.equal(markedDollars("  "), "—");
  assert.equal(markedDollars("0"), "$0.00");
});

test("undisclosed and invalid money bands never render zero", () => {
  assert.equal(moneyBand({ low: 0, high: 0 }), "Range unavailable");
  assert.equal(moneyBand({ low: 0, high: 50_000 }), "≤$50K");
  assert.equal(moneyBand({ low: 15_000, high: 0 }), "$15K+");
  assert.equal(moneyBand({ low: 50_000, high: 15_000 }), "Range unavailable");
});

test("known STOCK Act band midpoints render as ranges, never exact dollars", () => {
  assert.equal(moneyBand(stockActBandFromMidpoint(8000.5)), "$1K–$15K");
  assert.equal(moneyBand(stockActBandFromMidpoint(32500.5)), "$15K–$50K");
  assert.equal(moneyBand(stockActBandFromMidpoint(750000.5)), "$500K–$1M");
  assert.equal(moneyBand(stockActBandFromMidpoint(15000000.5)), "$5M–$25M");
});

test("unrecognized tracker amounts fall back to unavailable, not a fabricated figure", () => {
  assert.equal(moneyBand(stockActBandFromMidpoint(12345)), "Range unavailable");
  assert.equal(moneyBand(stockActBandFromMidpoint(null)), "Range unavailable");
});

test("finer OGE-278 sub-$15K bands resolve real disclosed trades instead of dropping them", () => {
  // 1750.5 is the real snapshot amount for Julia Letlow's CWI buy (src/lib/tracker/top20-snapshot.json).
  assert.equal(moneyBand(stockActBandFromMidpoint(1750.5)), "$1K–$3K");
  assert.equal(moneyBand(stockActBandFromMidpoint(3750.5)), "$3K–$5K");
  assert.equal(moneyBand(stockActBandFromMidpoint(10000.5)), "$5K–$15K");
  // the coarser 9-band PTR midpoint must still resolve unambiguously alongside the new finer bands.
  assert.equal(moneyBand(stockActBandFromMidpoint(8000.5)), "$1K–$15K");
});

test("explicitly disabled deposits override generic vault readiness", () => {
  const disabled = { indexId: "test", ready: true, depositEnabled: false, identity: { vaultAccount: owner, shareMint: owner } };
  assert.equal(depositIsEnabled(disabled), false);
  assert.equal(uiStateFrom(disabled), "PREVIEW_ONLY");
  assert.equal(depositIsEnabled({ ...disabled, depositEnabled: true }), true);
  assert.equal(uiStateFrom({ ...disabled, depositEnabled: true }), "LIVE_DEPOSIT");
});

test("public deposit eligibility requires a complete identity and the global release", () => {
  const created = { index: { vaultAddress: owner, shareMint: owner, network: "mainnet-beta" as const }, depositsEnabled: true, publicFundsEnabled: true };
  assert.equal(vaultReadinessFromIndex("test", created).depositEnabled, true);
  assert.equal(publicVaultDepositIsEnabled({ ...created.index, depositsEnabled: true, publicFundsEnabled: true }), true);

  const releaseClosed = vaultReadinessFromIndex("test", { ...created, publicFundsEnabled: false, depositReason: "blocked:internal-flag" });
  assert.equal(releaseClosed.depositEnabled, false);
  assert.deepEqual(releaseClosed.blockers, ["Public deposits are not open yet."]);
  assert.equal(publicVaultDepositIsEnabled({ ...created.index, depositsEnabled: true, publicFundsEnabled: false }), false);

  const noIdentity = vaultReadinessFromIndex("test", { ...created, index: { vaultAddress: owner, shareMint: owner } });
  assert.equal(noIdentity.depositEnabled, false);
  assert.equal(noIdentity.identity, null);
  assert.deepEqual(noIdentity.blockers, ["This index does not have a live vault yet."]);
});
