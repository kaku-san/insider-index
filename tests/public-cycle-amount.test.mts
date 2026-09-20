import assert from "node:assert/strict";
import test from "node:test";
import { Keypair } from "@solana/web3.js";
import { derivePublicCyclePolicy, resumePublicCyclePolicy, resolvePublicCyclePolicy } from "../src/lib/index-vaults/public-cycle-policy.ts";
import { initialCycleState } from "../src/lib/index-vaults/cycle-store.ts";
import { createCycleAccessChallenge } from "../src/lib/index-vaults/cycle-access.ts";
import { cyclePolicyHash } from "../src/lib/index-vaults/cycle-policy-parse.ts";
import { publicDepositAmountRaw, publicCycleNextRequest } from "../src/lib/frontend/public-cycle-controls.ts";
import { cycleTestPolicy } from "./support/cycle-policy.mts";

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
  await assert.rejects(resumePublicCyclePolicy(template, owner, template.limits.depositUsdcRaw, async () => ({ state })), /AMOUNT_ALREADY_SELECTED/);
  await assert.rejects(resumePublicCyclePolicy(template, owner, undefined, async () => { throw new Error("offline"); }), /offline/);
  await assert.rejects(resumePublicCyclePolicy(template, owner, undefined, async () => ({ state: { ...state, approvedDepositUsdcRaw: "1" } })), /IDENTITY_OR_POLICY_CHANGED/);
});

test("HMAC access binds selected amount, not a prepare-body spending override", () => {
  const template = { ...cycleTestPolicy(), notBeforeSlot: 1, expiresAt: Date.now() + 3600000, financialExecutionAuthorized: true, approvalReference: "LOCAL-TEST-ONLY", feeScheduleHash: "a".repeat(64) };
  template.economics = { keeperSurplus: "native-filler-retains", shareQuantization: "bounded-native-units", residualCash: "native-backing", issuerAuthorityRiskApproved: true, nativeSettlementRiskApproved: true };
  const selected = derivePublicCyclePolicy(template, template.owner, "123456789");
  const env = { STOCKLANA_CYCLE_AUTH_SECRET: "LOCAL-TEST-SECRET-ONLY-12345678901234567890", STOCKLANA_CYCLE_POLICIES_JSON: JSON.stringify([template]) };
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
});
