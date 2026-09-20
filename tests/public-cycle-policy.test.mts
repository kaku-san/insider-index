import assert from "node:assert/strict";
import test from "node:test";
import { Keypair } from "@solana/web3.js";
import { cycleTestPolicy } from "./support/cycle-policy.mts";
import { derivePublicCycleOperationId, derivePublicCyclePolicy } from "../src/lib/index-vaults/public-cycle-policy.ts";

test("Mag7 depositor derivation keeps the original owner operation and copies vault limits", () => {
  const template = { ...cycleTestPolicy(), notBeforeSlot: 1 };
  const other = Keypair.fromSeed(new Uint8Array(32).fill(32)).publicKey.toBase58();
  assert.equal(derivePublicCyclePolicy(template, template.owner).operationId, template.operationId);
  const derived = derivePublicCyclePolicy(template, other);
  assert.equal(derived.owner, other);
  assert.notEqual(derived.operationId, template.operationId);
  assert.equal(derived.operationId, derivePublicCycleOperationId(template.operationId, other));
  assert.equal(derived.vault, template.vault);
  assert.equal(derived.shareMint, template.shareMint);
  assert.equal(derived.keeper, template.keeper);
  assert.equal(derived.limits.depositUsdcRaw, template.limits.depositUsdcRaw);
  assert.equal(derived.indexId, template.indexId);
  assert.throws(() => derivePublicCyclePolicy(template, template.keeper), /POLICY_UNAVAILABLE/);
  assert.equal(derivePublicCycleOperationId(template.operationId, other), derivePublicCycleOperationId(template.operationId, other));
});
