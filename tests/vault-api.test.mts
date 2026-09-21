import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { PublicKey, TransactionMessage, VersionedTransaction } from "@solana/web3.js";

register("./support/ui-loader.mjs", import.meta.url);
const { creditHasRemainingAmount, depositIsEnabled, publicIndexIsLive, publicIndexStatus, publicIndexStatusCopy, publicVaultDepositIsEnabled, uiStateFrom, validatePreparedStep, vaultReadinessFromIndex } = await import("../src/lib/frontend/vault-api.ts");
const { markedDollars, moneyBand, stockActBandFromMidpoint } = await import("../src/lib/frontend/research-format.ts");

const owner = "Jh7cFNUT5FrtBwKakApsc3Gg5aTQjsZtYxa4dbrCoB8";
function preparedPayload(requires: "user-signature" | "wait" = "user-signature") {
  const message = new TransactionMessage({ payerKey: new PublicKey(owner), recentBlockhash: owner, instructions: [] }).compileToV0Message();
  const transaction = new VersionedTransaction(message);
  return {
    operationId: "operation-1",
    phase: "AWAITING_SIGNATURE",
    requires,
    configHash: "config-hash",
    constraints: [],
    blockers: [],
    transactions: requires === "user-signature" ? [{
      stepId: "deposit-contribution", messageBase64: Buffer.from(transaction.serialize()).toString("base64"), messageHash: bytesToHex(sha256(message.serialize())),
      requiredSigners: [owner], allowedProgramIds: [], maxDebits: [], expectedRecipients: [], recentBlockhash: owner, lastValidBlockHeight: 1,
    }] : [],
  };
}

test("native wallet signing accepts only an unsigned transaction bound to the selected wallet", async () => {
  const prepared = await validatePreparedStep(preparedPayload(), { owner, network: "devnet" });
  assert.equal(prepared.transactions.length, 1);
  const altered = preparedPayload();
  altered.transactions[0].messageHash = "0".repeat(64);
  await assert.rejects(validatePreparedStep(altered, { owner, network: "devnet" }), /does not match this wallet/);
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
  assert.deepEqual(releaseClosed.blockers, ["Investing isn't open for signatures yet."]);
  assert.doesNotMatch(releaseClosed.blockers.join(" "), /publicFundsEnabled|VAULT_RELEASE|internal-flag/);
  assert.equal(publicVaultDepositIsEnabled({ ...created.index, depositsEnabled: true, publicFundsEnabled: false }), false);

  const noIdentity = vaultReadinessFromIndex("test", { ...created, index: { vaultAddress: owner, shareMint: owner } });
  assert.equal(noIdentity.depositEnabled, false);
  assert.equal(noIdentity.identity, null);
  assert.deepEqual(noIdentity.blockers, ["This index is for research. Investing is not available yet."]);
});

test("a public index is Live only when the active signing path also allows deposits", () => {
  const mag7 = {
    vaultAddress: "AwDFvjEPPwdF1YgXV8asNt6LeEFDduinYneCn6mHDAsh",
    shareMint: "9ihGfswnUZ6MysSR3KgmrZ57FXDVAiAQ6sEHwLuWwzJ4",
    network: "mainnet-beta" as const,
    depositsEnabled: true,
    publicFundsEnabled: false,
  };
  assert.equal(publicIndexIsLive(mag7), false);
  assert.equal(publicIndexStatus(mag7), "Coming soon");
  assert.equal(publicIndexStatusCopy("Coming soon"), "This index has a vault. Investing is not open yet.");
  assert.equal(publicVaultDepositIsEnabled(mag7), false);

  const liveMag7 = { ...mag7, publicFundsEnabled: true };
  assert.equal(publicIndexIsLive(liveMag7), true);
  assert.equal(publicIndexStatus(liveMag7), "Live");
  assert.equal(publicIndexStatusCopy("Live"), "You can invest in this index.");
  assert.equal(depositIsEnabled(vaultReadinessFromIndex("idx-theme-mag7-caucus", {
    index: mag7, depositsEnabled: true, publicFundsEnabled: false,
  })), false);

  const research = { vaultAddress: null, shareMint: null, network: "mainnet-beta" as const, depositsEnabled: false, publicFundsEnabled: false };
  assert.equal(publicIndexIsLive(research), false);
  assert.equal(publicIndexStatus(research), "Research");
  assert.equal(publicIndexStatusCopy("Research"), "This index is for research. Investing is not available yet.");
});
