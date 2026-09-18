import assert from "node:assert/strict";
import { test } from "node:test";
import bs58 from "bs58";
import { ed25519 } from "@noble/curves/ed25519";
import { cycleTestPolicy, cycleTestOwner, cycleTestKeeper } from "./support/cycle-policy.mts";
import { createCycleAccessChallenge, assertCycleAccess } from "../src/lib/index-vaults/cycle-access.ts";
import { validateCycleAccessMessage } from "../src/lib/index-vaults/cycle-access-parse.ts";
import { configuredCyclePolicy, parseCyclePolicy } from "../src/lib/index-vaults/cycle-config.ts";
import { handleCycleRequest } from "../src/lib/index-vaults/cycle-api.ts";
const origin = "https://insiderindex.xyz", env = { STOCKLANA_CYCLE_AUTH_SECRET: "SYNTHETIC-TEST-AUTH-SECRET-NOT-PRODUCTION" };
function policy() { return { ...cycleTestPolicy(), notBeforeSlot: 448001055 }; }
function signature(message: string, key = cycleTestOwner) { return bs58.encode(ed25519.sign(new TextEncoder().encode(message), key.secretKey.subarray(0, 32))); }
test("private access requires actual owner message signature and binds origin, operation, policy and deadline", () => {
  const p = policy(), challenge = createCycleAccessChallenge(p, origin, env, 10000), proof = { token: challenge.token, signature: signature(challenge.message) };
  assertCycleAccess(proof, p, origin, env, 10001);
  assert.equal(validateCycleAccessMessage(challenge, p, origin, p.owner, 10001), challenge.message);
  assert.throws(() => validateCycleAccessMessage({ ...challenge, message: "Authorize unrelated spending" }, p, origin, p.owner, 10001), /CHALLENGE_TEXT/);
  assert.throws(() => validateCycleAccessMessage(challenge, p, origin, p.keeper, 10001), /CHALLENGE_SCOPE/);
  assert.throws(() => assertCycleAccess({ ...proof, signature: signature(challenge.message, cycleTestKeeper) }, p, origin, env, 10001), /ACCESS_SIGNATURE/);
  assert.throws(() => assertCycleAccess({ ...proof, token: `${proof.token}a` }, p, origin, env, 10001), /ACCESS_INVALID/);
  assert.throws(() => assertCycleAccess(proof, p, "https://other.example", env, 10001), /ACCESS_EXPIRED_OR_SCOPE/);
  assert.throws(() => assertCycleAccess(proof, { ...p, operationId: "77777777-7777-4777-8777-777777777777" }, origin, env, 10001), /ACCESS_EXPIRED_OR_SCOPE/);
  assert.throws(() => assertCycleAccess(proof, { ...p, limits: { ...p.limits, depositUsdcRaw: "2" } }, origin, env, 10001), /ACCESS_EXPIRED_OR_SCOPE/);
  assert.throws(() => assertCycleAccess(proof, p, origin, env, challenge.expiresAt), /ACCESS_EXPIRED_OR_SCOPE/);
  assert.throws(() => createCycleAccessChallenge(p, origin, {}), /ACCESS_UNCONFIGURED/);
});
test("operator policy parsing never defaults missing authority, coerces booleans or admits ambiguous operations", () => {
  const p = policy(); assert.deepEqual(parseCyclePolicy(p), p);
  assert.throws(() => parseCyclePolicy({ ...p, financialExecutionAuthorized: "true" }), /CONFIG_AUTHORITY/);
  assert.throws(() => parseCyclePolicy({ ...p, notBeforeSlot: 0 }), /CONFIG_AUTHORITY/);
  assert.throws(() => parseCyclePolicy({ ...p, extra: true }), /CONFIG_SHAPE/);
  assert.throws(() => parseCyclePolicy({ ...p, economics: { ...p.economics, issuerAuthorityRiskApproved: "true" } }), /CONFIG_ECONOMICS/);
  assert.throws(() => parseCyclePolicy({ ...p, limits: { ...p.limits, depositUsdcRaw: 100 } }), /CONFIG_RAW_AMOUNT/);
  assert.throws(() => configuredCyclePolicy(p.operationId, {}), /PRIVATE_OPERATION_UNAVAILABLE/);
  assert.throws(() => configuredCyclePolicy(p.operationId, { STOCKLANA_CYCLE_POLICIES_JSON: JSON.stringify([p, p]) }), /CONFIG_DUPLICATE_OPERATION/);
});
test("private API is closed without operator configuration and rejects wrong origins/client financial authority before any runner exists", async () => {
  const p = policy(), configured = { ...env, STOCKLANA_CYCLE_POLICIES_JSON: JSON.stringify([p]) };
  const request = (body: unknown, source = origin) => new Request(`${origin}/api/vaults/cycle`, { method: "POST", headers: { origin: source, "content-type": "application/json" }, body: JSON.stringify(body) });
  const unavailable = await handleCycleRequest(request({ operationId: p.operationId, action: "challenge", wallet: p.owner }), { env: {} });
  assert.equal(unavailable.status, 404);
  const challengeResponse = await handleCycleRequest(request({ operationId: p.operationId, action: "challenge", wallet: p.owner }), { env: configured });
  assert.equal(challengeResponse.status, 200); assert.match(challengeResponse.headers.get("cache-control")!, /no-store/);
  const { challenge } = await challengeResponse.json();
  const auth = { token: challenge.token, signature: signature(challenge.message) };
  let constructed = 0;
  const dependencies = { env: configured, runner: () => { constructed++; throw new Error("TEST_RUNNER_REACHED"); } };
  for (const body of [
    { operationId: p.operationId, action: "read" },
    { operationId: p.operationId, action: "prepare", auth, policy: p },
    { operationId: p.operationId, action: "prepare", auth, actor: "keeper" },
    { operationId: p.operationId, action: "submit", auth, credits: [] },
  ]) assert.notEqual((await handleCycleRequest(request(body), dependencies)).status, 200);
  assert.equal((await handleCycleRequest(request({ operationId: p.operationId, action: "read", auth }, "https://other.example"), dependencies)).status, 403);
  assert.equal(constructed, 0);
  await handleCycleRequest(request({ operationId: p.operationId, action: "read", auth }), dependencies);
  assert.equal(constructed, 1, "only an actual owner session reaches journal/native services");
  assert.equal((await handleCycleRequest(request({ oversized: "x".repeat(9000) }), dependencies)).status, 409);
});
