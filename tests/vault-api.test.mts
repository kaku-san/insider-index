import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { register } from "node:module";
import test from "node:test";
import { PublicKey, SystemProgram, Transaction } from "@solana/web3.js";

register("./support/ui-loader.mjs", import.meta.url);
const { creditHasRemainingAmount, validatePreparedStep } = await import("../src/lib/frontend/vault-api.ts");
const { markedDollars } = await import("../src/lib/frontend/research-format.ts");

const owner = "Jh7cFNUT5FrtBwKakApsc3Gg5aTQjsZtYxa4dbrCoB8";
const recipient = "Cdxoni8uv7FrqVfeHJ6YC4DeXs3QQ2uG4nT3BDd9Ny2A";

function preparedPayload() {
  const transaction = new Transaction({ feePayer: new PublicKey(owner), recentBlockhash: recipient }).add(SystemProgram.transfer({ fromPubkey: new PublicKey(owner), toPubkey: new PublicKey(recipient), lamports: 1 }));
  const message = transaction.serializeMessage();
  return {
    operationId: "operation-1",
    phase: "AWAITING_SIGNATURE",
    requires: "user-signature",
    configHash: "config-hash",
    constraints: [],
    blockers: [],
    transactions: [{
      stepId: "deposit-contribution",
      messageBase64: Buffer.from(message).toString("base64"),
      messageHash: createHash("sha256").update(message).digest("hex"),
      requiredSigners: [owner],
      allowedProgramIds: [SystemProgram.programId.toBase58()],
      maxDebits: [{ owner, mint: recipient, amountRaw: "9007199254740993" }],
      expectedRecipients: [{ owner: recipient, mint: recipient }],
      recentBlockhash: recipient,
      lastValidBlockHeight: 123,
      simulation: { ok: true, slot: 456, logsHash: "logs-hash" },
    }],
  };
}

test("prepared steps are exposed only after wallet, message, program, and simulation validation", async () => {
  const valid = preparedPayload();
  const prepared = await validatePreparedStep(valid, { owner, network: "devnet" });
  assert.equal(prepared.network, "devnet");

  await assert.rejects(validatePreparedStep({ ...valid, transactions: [{ ...valid.transactions[0], simulation: { ...valid.transactions[0].simulation, ok: false } }] }, { owner, network: "devnet" }), /simulation did not pass/);
  await assert.rejects(validatePreparedStep({ ...valid, transactions: [{ ...valid.transactions[0], requiredSigners: [recipient] }] }, { owner, network: "devnet" }), /declared signers/);
  await assert.rejects(validatePreparedStep({ ...valid, transactions: [{ ...valid.transactions[0], messageHash: "0".repeat(64) }] }, { owner, network: "devnet" }), /hash does not match/);
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
