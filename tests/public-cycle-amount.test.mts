import assert from "node:assert/strict";
import test from "node:test";
import { Keypair } from "@solana/web3.js";
import { derivePublicCyclePolicy, resumePublicCyclePolicy, resolvePublicCyclePolicy } from "../src/lib/index-vaults/public-cycle-policy.ts";
import { CycleJournal, initialCycleState } from "../src/lib/index-vaults/cycle-store.ts";
import { createCycleAccessChallenge } from "../src/lib/index-vaults/cycle-access.ts";
import { cyclePolicyHash } from "../src/lib/index-vaults/cycle-policy-parse.ts";
import { publicDepositAmountRaw, publicCycleNextRequest, publicCyclePrimaryCta } from "../src/lib/frontend/public-cycle-controls.ts";
import { publicCycleErrorCopy, publicCycleStatusCopy } from "../src/lib/frontend/public-cycle-copy.ts";
import { cycleTestPolicy } from "./support/cycle-policy.mts";
import { cycleDb } from "./support/cycle-db.mts";

test("chosen USDC amount scales minima without a product cap or relaxed slippage", async () => {
  const template = { ...cycleTestPolicy(), notBeforeSlot: 1 }, owner = Keypair.fromSeed(new Uint8Array(32).fill(32)).publicKey.toBase58();
  const amount = (BigInt(template.limits.depositUsdcRaw) * 500n).toString();
  const chosen = derivePublicCyclePolicy(template, owner, amount);
  assert.equal(chosen.limits.depositUsdcRaw, amount);
  assert.equal(chosen.limits.minExitUsdcRaw, (BigInt(template.limits.minExitUsdcRaw) * 500n).toString());
  assert.equal(chosen.limits.minNetSharesRaw, (BigInt(template.limits.minNetSharesRaw) * 500n).toString());
  for (const key of ["swapSlippageBps", "rebalanceSlippageBps", "perTradeSlippageBps", "maxOwnerSolDebitLamports"] as const) assert.equal(chosen.limits[key], template.limits[key]);
  for (const invalid of ["0", "-1", "1.1", "1e6", "01", "9007199254740992"]) assert.throws(() => derivePublicCyclePolicy(template, owner, invalid), /AMOUNT_INVALID/);
  assert.throws(() => derivePublicCyclePolicy(template, template.keeper, amount), /POLICY_UNAVAILABLE/);
  const state = initialCycleState(chosen);
  assert.deepEqual(await resumePublicCyclePolicy(template, owner, undefined, async () => ({ state })), chosen);
  const db = await cycleDb();
  try {
    const journal = new CycleJournal(chosen, db.rpc);
    await journal.update(() => {});
    const restarted = await resumePublicCyclePolicy(template, owner, template.limits.depositUsdcRaw, db.rpc);
    assert.equal(restarted.limits.depositUsdcRaw, template.limits.depositUsdcRaw, "an empty journal restarts with the requested amount");
    assert.equal((await new CycleJournal(restarted, db.rpc).read()).approvedDepositUsdcRaw, template.limits.depositUsdcRaw);
    await new CycleJournal(restarted, db.rpc).update(s => { s.contributedUsdcRaw = "1"; });
    await assert.rejects(resumePublicCyclePolicy(template, owner, amount, db.rpc), /AMOUNT_ALREADY_SELECTED/, "real funding progress permanently locks the amount");
  } finally { await db.close(); }
  await assert.rejects(resumePublicCyclePolicy(template, owner, undefined, async () => { throw new Error("offline"); }), /offline/);
  await assert.rejects(resumePublicCyclePolicy(template, owner, undefined, async () => ({ state: { ...state, approvedDepositUsdcRaw: "1" } })), /IDENTITY_OR_POLICY_CHANGED/);
});

test("HMAC access binds selected amount, not a prepare-body spending override", () => {
  const template = { ...cycleTestPolicy(), notBeforeSlot: 1, expiresAt: Date.now() + 3600000, financialExecutionAuthorized: true, approvalReference: "LOCAL-TEST-ONLY", feeScheduleHash: "a".repeat(64) };
  template.economics = { keeperSurplus: "native-filler-retains", shareQuantization: "bounded-native-units", residualCash: "native-backing", issuerAuthorityRiskApproved: true, nativeSettlementRiskApproved: true };
  const selected = derivePublicCyclePolicy(template, template.owner, "123456789");
  const env = { STOCKLANA_CYCLE_AUTH_SECRET: "LOCAL-TEST-SECRET-ONLY-12345678901234567890", STOCKLANA_CYCLE_POLICIES_JSON: JSON.stringify([template]) };
  assert.equal(resolvePublicCyclePolicy({ operationId: template.operationId }, env).operationId, template.operationId, "the private operator path retains its configured operation");
  const challenge = createCycleAccessChallenge(selected, "https://insiderindex.xyz", env);
  const auth = { token: challenge.token, signature: "unused-before-owner-verification" };
  assert.equal(cyclePolicyHash(resolvePublicCyclePolicy({ operationId: selected.operationId, auth }, env)), cyclePolicyHash(selected));
  const [encoded, mac] = auth.token.split(".");
  const claims = JSON.parse(Buffer.from(encoded, "base64url").toString()); claims.depositUsdcRaw = "999999999";
  assert.throws(() => resolvePublicCyclePolicy({ operationId: selected.operationId, auth: { ...auth, token: `${Buffer.from(JSON.stringify(claims)).toString("base64url")}.${mac}` } }, env), /ACCESS_INVALID/);
});

test("USDC decimal input is exact; cash out continues through every conversion, not just burn", () => {
  assert.equal(publicDepositAmountRaw("12.345678"), "12345678");
  assert.equal(publicDepositAmountRaw("0.000001"), "1");
  for (const invalid of ["", "0", "-2", "NaN", "1e3", "1.0000001", "9007199255"]) assert.throws(() => publicDepositAmountRaw(invalid), /AMOUNT_INVALID/);
  const state = { pending: null, recoveryRequired: null, phase: "holding" as const };
  assert.equal(publicCycleNextRequest("withdraw", state), "withdraw");
  assert.equal(publicCycleNextRequest("withdraw", { ...state, phase: "exiting" }), "next");
  assert.equal(publicCycleNextRequest("withdraw", { ...state, phase: "recovering" }), "next");
  assert.equal(publicCycleNextRequest("withdraw", { ...state, phase: "complete" }), null);
  assert.equal(publicCycleNextRequest("withdraw", { ...state, recoveryRequired: "attention" }), "recover");
  assert.equal(publicCycleNextRequest("deposit", state, true), "next", "a first deposit must prepare from the holding phase");
  assert.equal(publicCycleNextRequest("deposit", state, false), null, "a closed deposit gate cannot prepare a new contribution");
});

test("public modal presents one clear next action from review through wallet signature", () => {
  const input = { mode: "deposit" as const, walletConnected: true, accessReady: true, authorized: true, pending: false, canRetry: false, nextRequest: "next" as const };
  assert.deepEqual(publicCyclePrimaryCta({ ...input, walletConnected: false }), { action: "connect", label: "Connect wallet" });
  assert.deepEqual(publicCyclePrimaryCta({ ...input, accessReady: false }), { action: "discover", label: "Review amount" });
  assert.deepEqual(publicCyclePrimaryCta({ ...input, accessReady: false, resumeSavedAmount: true }), { action: "discover", label: "Continue existing with saved amount" });
  assert.deepEqual(publicCyclePrimaryCta({ ...input, authorized: false }), { action: "authorize", label: "Confirm in wallet" });
  assert.deepEqual(publicCyclePrimaryCta(input), { action: "prepare", label: "Prepare investment" });
  assert.deepEqual(publicCyclePrimaryCta({ ...input, pending: true }), { action: "sign", label: "Sign in wallet" });
  assert.deepEqual(publicCyclePrimaryCta({ ...input, pending: true, canRetry: true }), { action: "retry", label: "Retry signed action" });
  assert.deepEqual(publicCyclePrimaryCta({ ...input, mode: "withdraw", accessReady: false }), { action: "discover", label: "Cash out to USDC" });
  assert.deepEqual(publicCyclePrimaryCta({ ...input, mode: "withdraw", nextRequest: "withdraw" }), { action: "prepare", label: "Cash out to USDC" });
});

test("prepare failures give investors usable copy instead of a generic unavailable state", () => {
  for (const code of ["CYCLE_PERSISTED_KEEPER_AUTHORITY_REQUIRED", "CYCLE_PARTIAL_COVERAGE_OR_DEPOSITS_CLOSED", "CYCLE_PUBLIC_DEPOSITS_CLOSED", "CYCLE_LEG_UNREADY:mint"]) {
    assert.equal(publicCycleErrorCopy(new Error(code), "deposit"), "Invest isn't set up for this index yet.");
  }
  assert.equal(publicCycleErrorCopy(new Error("CYCLE_AUTHORIZATION_EXPIRED"), "deposit"), "Your approval expired. Review the amount and confirm again.");
  assert.equal(publicCycleStatusCopy(Object.assign(new Error("Invest isn't available right now."), { code: "CYCLE_POLICY_IDENTITY_CHANGED" }), "deposit"), "Investment setup changed. Tap Prepare again.");
});
