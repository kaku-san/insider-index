import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register("./support/ui-loader.mjs", import.meta.url);
const { creditHasRemainingAmount, validatePreparedStep } = await import("../src/lib/frontend/vault-api.ts");
const { markedDollars } = await import("../src/lib/frontend/research-format.ts");

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
