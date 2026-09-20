import assert from "node:assert/strict";
import test from "node:test";
import { publicCycleErrorBody, publicCycleErrorCopy } from "../src/lib/frontend/public-cycle-copy.ts";

test("Mag7 public errors never expose lifecycle codes or recovery instructions", () => {
  for (const error of [
    new Error("CYCLE_PUBLIC_POLICY_UNAVAILABLE"),
    new Error("CYCLE_ACCESS_REQUIRED"),
    new Error("CYCLE_CLIENT_SCOPE"),
    new Error("CYCLE_UNSAFE_INTERNAL_DETAIL"),
    new Error("wallet rejected"),
    new Error("Retain the operation and exact signed bytes. Reconcile; never repeat funding or burn."),
  ]) {
    const copy = publicCycleErrorCopy(error, "deposit");
    assert.doesNotMatch(copy, /CYCLE_|recovery|reconcile|funding|burn|Retain the operation/i);
  }
  assert.equal(publicCycleErrorCopy(new Error("CYCLE_PUBLIC_POLICY_UNAVAILABLE"), "deposit"), "Invest isn't available for this wallet.");
  assert.equal(publicCycleErrorCopy(new Error("CYCLE_ACCESS_REQUIRED"), "deposit"), "Connect your wallet.");
  assert.equal(publicCycleErrorCopy(new Error("CYCLE_UNSAFE_INTERNAL_DETAIL"), "deposit"), "Invest isn't available right now.");
  assert.equal(publicCycleErrorCopy(new Error("CYCLE_UNSAFE_INTERNAL_DETAIL"), "withdraw"), "Cash out isn't available right now.");
  const body = publicCycleErrorBody(new Error("CYCLE_PUBLIC_POLICY_UNAVAILABLE"));
  assert.equal(body.error, "CYCLE_PUBLIC_POLICY_UNAVAILABLE");
  assert.equal(body.message, "Invest isn't available for this wallet.");
  assert.equal("recovery" in body, false);
});
