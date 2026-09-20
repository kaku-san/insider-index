import assert from "node:assert/strict";
import test from "node:test";
import { publicCycleErrorCopy } from "../src/lib/frontend/public-cycle-copy.ts";

test("Mag7 public errors never expose lifecycle codes or recovery instructions", () => {
  for (const error of [
    new Error("CYCLE_PUBLIC_POLICY_UNAVAILABLE"),
    new Error("CYCLE_ACCESS_REQUIRED"),
    new Error("CYCLE_CLIENT_SCOPE"),
    new Error("CYCLE_UNSAFE_INTERNAL_DETAIL"),
    new Error("wallet rejected"),
  ]) {
    const copy = publicCycleErrorCopy(error, "deposit");
    assert.doesNotMatch(copy, /CYCLE_|recovery|reconcile|funding|burn/i);
  }
  assert.equal(publicCycleErrorCopy(new Error("CYCLE_PUBLIC_POLICY_UNAVAILABLE"), "deposit"), "Connect the wallet used for Mag7.");
  assert.equal(publicCycleErrorCopy(new Error("CYCLE_UNSAFE_INTERNAL_DETAIL"), "deposit"), "Invest isn't available for this wallet.");
  assert.equal(publicCycleErrorCopy(new Error("CYCLE_UNSAFE_INTERNAL_DETAIL"), "withdraw"), "Cash out isn't available right now.");
});
