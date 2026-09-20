import assert from "node:assert/strict";
import { test } from "node:test";
import { createCycleReadConnection } from "../src/lib/frontend/cycle-rpc.ts";
import { assertCycleWireResolved } from "../src/lib/frontend/cycle-sign.ts";
import type { CyclePending } from "../src/lib/index-vaults/cycle-store.ts";

// Exact retained-wire absence contract through the real web3 JSON-RPC consumer, no live I/O.
const genesis = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const pending = { minSlot: 100, blockhash: "root", lastValidBlockHeight: 8, messageHash: "hash" } as CyclePending;
const signature = "retained-signature";
function fixture(change: "none" | "wrong-network" | "valid" | "missing-root" | "hidden-block" | "known-signature" | "incomplete") {
  const calls: string[] = [];
  const connection = createCycleReadConnection("https://insiderindex.xyz", async (url, init) => {
    assert.equal(url, "https://insiderindex.xyz/api/rpc");
    const { id, method, params } = JSON.parse(String(init?.body)); calls.push(method);
    let result: unknown;
    if (method === "getGenesisHash") result = change === "wrong-network" ? "wrong" : genesis;
    else if (method === "getTransaction") result = null;
    else if (method === "isBlockhashValid") result = { context: { slot: change === "incomplete" ? 102 : 103 }, value: change === "valid" };
    else if (method === "getBlockHeight") result = 10;
    else if (method === "getBlock") {
      assert.deepEqual(params[1], { commitment: "finalized", transactionDetails: "signatures", rewards: false });
      const slot = params[0];
      if (slot === 100 && change === "missing-root") result = null;
      else if (slot === 101) return Response.json({ jsonrpc: "2.0", id, error: { code: -32007, message: "Slot skipped or missing" } });
      else result = { blockhash: slot === 100 ? "root" : `block-${slot}`, previousBlockhash: slot === 102 ? "root" : `block-${slot - 1}`, parentSlot: slot === 102 && change !== "hidden-block" ? 100 : slot - 1, blockHeight: slot === 100 ? 7 : slot === 102 ? 8 : 9, blockTime: null, signatures: slot === 102 && change === "known-signature" ? [signature] : [] };
    } else throw new Error(`UNEXPECTED_RPC:${method}`);
    return Response.json({ jsonrpc: "2.0", id, result });
  });
  return { connection, calls };
}
test("retained signed wire retirement requires canonical finalized continuity, not null receipt or timeout", async () => {
  const healthy = fixture("none");
  await assertCycleWireResolved(healthy.connection, pending, signature);
  assert.equal(healthy.calls.filter(m => m === "getBlock").length, 4, "real web3 preserves the RPC blockHeight and proves a skipped slot by parent continuity");
  for (const [change, error] of [["wrong-network", /WRONG_NETWORK/], ["valid", /UNRESOLVED/], ["missing-root", /not found/], ["hidden-block", /HISTORY_GAP/], ["known-signature", /RECEIPT_UNAVAILABLE/], ["incomplete", /HISTORY_LIMIT/]] as const) {
    await assert.rejects(assertCycleWireResolved(fixture(change).connection, pending, signature), error);
  }
});
