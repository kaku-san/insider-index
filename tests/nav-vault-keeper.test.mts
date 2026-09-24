import test from "node:test";
import assert from "node:assert/strict";
import { PublicKey } from "@solana/web3.js";
import {
  KEEPER_DEFER_BASE_SECS, KEEPER_DEFER_MAX_SECS, errorText, isDeferred, isUnsellableError, planRebalance, rebalanceDeferKey, recordFailure, withinPriceBound,
  type KeeperDeferrals,
} from "../src/lib/nav-vault/keeper.ts";
import { USDC_LEG } from "../src/lib/nav-vault/program.ts";
import { throttledFetch } from "../src/lib/nav-vault/rpc-throttle.ts";

const MAINNET_SIMULATION_FAILURE = [
  "Simulation failed. ",
  "Message: Transaction simulation failed: Error processing Instruction 2: custom program error: 0x1788. ",
  "Logs: ",
  '["Program log: AnchorError thrown in nav-vault/src/lib.rs:636. Error Code: SwapPriceBound. Error Number: 6024."]',
].join("\n");

test("failing legs back off exponentially up to the cap and expire", () => {
  const deferrals: KeeperDeferrals = new Map();
  const key = rebalanceDeferKey(PublicKey.default, "sell", 4);
  const first = recordFailure(deferrals, key, 1_000, "SwapPriceBound", true);
  assert.equal(first.until, 1_000 + KEEPER_DEFER_BASE_SECS);
  assert.ok(isDeferred(deferrals, key, 1_000 + KEEPER_DEFER_BASE_SECS - 1));
  assert.ok(!isDeferred(deferrals, key, 1_000 + KEEPER_DEFER_BASE_SECS));
  assert.equal(recordFailure(deferrals, key, 2_000, "x", true).until, 2_000 + 2 * KEEPER_DEFER_BASE_SECS);
  for (let i = 0; i < 10; i++) recordFailure(deferrals, key, 3_000, "x", true);
  assert.equal(deferrals.get(key)!.until, 3_000 + KEEPER_DEFER_MAX_SECS, "capped");
  assert.ok(!isDeferred(deferrals, rebalanceDeferKey(PublicKey.default, "buy", 4), 3_000), "buy and sell are deferred separately");
});

test("swap failures: price bound / slippage are unsellable; RPC and stale marks are transient", () => {
  assert.ok(isUnsellableError(new Error(MAINNET_SIMULATION_FAILURE)), "the live Pelosi keeper failure");
  assert.ok(isUnsellableError(new Error("custom program error: 0x1771")), "Jupiter slippage tolerance");
  assert.ok(isUnsellableError(new Error("TransactionErrorInstructionError { index: 1, error: InstructionErrorCustom { code: 6024 } }")));
  assert.ok(!isUnsellableError(new Error("429 Too Many Requests")));
  assert.ok(!isUnsellableError(new Error("custom program error: 0x177c")), "StalePrices is transient");
  assert.ok(!isUnsellableError(new Error("block height exceeded")));
  assert.match(errorText(new Error(MAINNET_SIMULATION_FAILURE)), /^SwapPriceBound \(0x1788\): Simulation failed/);
});

test("price-bound pre-check mirrors the program at posted marks", () => {
  const vault = { maxSlippageBps: 100, legs: [{ price: 358_883_467n, decimals: 8 }] } as Parameters<typeof withinPriceBound>[0];
  // The live AVGO top-up sale: 92_224 raw AVGO (~$0.331 at the ask mark) quoted 324_437 raw USDC (~2% under).
  const amountIn = 92_224n;
  assert.equal(withinPriceBound(vault, 0, USDC_LEG, amountIn, 324_437n), false);
  assert.equal(withinPriceBound(vault, 0, USDC_LEG, amountIn, 328_000n), true);
  assert.equal(withinPriceBound(vault, USDC_LEG, 0, 1_000_000n, 276_000n), true, "a buy at the ask mark passes");
});

test("a skipped (deferred) buffer sale falls through to the next overweight leg", () => {
  const legs = [{ weightBps: 5000, price: 100_000_000n, decimals: 6 }, { weightBps: 5000, price: 100_000_000n, decimals: 6 }];
  const input = { legs, usdc: 0n, legBalances: [6_000_000n, 5_000_000n], bufferBps: 500 };
  assert.equal(planRebalance(input)[0]!.leg, 0);
  const skipped = planRebalance({ ...input, skip: (kind, leg) => kind === "sell" && leg === 0 });
  assert.deepEqual(skipped.map(a => [a.kind, a.leg]), [["sell", 1]]);
});

test("throttled RPC fetch: one request at a time, spaced, 429 backoff honouring Retry-After", async () => {
  let clock = 0;
  const sleeps: number[] = [];
  const starts: number[] = [];
  let inFlight = 0, maxInFlight = 0;
  const statuses = [429, 200, 200, 200];
  const fetchImpl = (async () => {
    starts.push(clock);
    inFlight += 1; maxInFlight = Math.max(maxInFlight, inFlight);
    await Promise.resolve();
    inFlight -= 1;
    const status = statuses.shift() ?? 200;
    return new Response("{}", { status, headers: status === 429 ? { "retry-after": "2" } : {} });
  }) as typeof fetch;
  const limited: number[] = [];
  const paced = throttledFetch({ fetchImpl, minIntervalMs: 100, now: () => clock, sleep: async ms => { sleeps.push(ms); clock += ms; }, onRateLimited: (_, delay) => limited.push(delay) });
  const responses = await Promise.all([paced("rpc"), paced("rpc"), paced("rpc")]);
  assert.deepEqual(responses.map(r => r.status), [200, 200, 200]);
  assert.equal(maxInFlight, 1, "sequential");
  assert.deepEqual(limited, [2_000], "Retry-After seconds honoured");
  for (let i = 1; i < starts.length; i++) assert.ok(starts[i]! - starts[i - 1]! >= 100, "spaced");
  const giveUp = throttledFetch({ fetchImpl: (async () => new Response("", { status: 429 })) as typeof fetch, maxRetries: 2, sleep: async () => undefined });
  assert.equal((await giveUp("rpc")).status, 429, "returns the 429 after the retry budget");
});

test("request slices retry on a short backoff so the keeper keeps selling until the request timeout", async () => {
  const { KEEPER_FULFILL_DEFER_BASE_SECS, KEEPER_FULFILL_DEFER_MAX_SECS, fulfillDeferKey } = await import("../src/lib/nav-vault/keeper.ts");
  const deferrals: KeeperDeferrals = new Map();
  const key = fulfillDeferKey(PublicKey.default, 1);
  assert.equal(recordFailure(deferrals, key, 0, "SwapPriceBound", true).until, KEEPER_FULFILL_DEFER_BASE_SECS);
  for (let i = 0; i < 10; i++) recordFailure(deferrals, key, 1_000, "x", true);
  assert.equal(deferrals.get(key)!.until, 1_000 + KEEPER_FULFILL_DEFER_MAX_SECS, "capped well inside the 600 s request timeout");
  assert.ok(KEEPER_FULFILL_DEFER_MAX_SECS * 4 <= 600);
});

test("marks are the mid of ask and bid; the ask alone when the bid is missing or crossed", async () => {
  const { midMark } = await import("../src/lib/nav-vault/mainnet-venue.ts");
  assert.equal(midMark(1_000_000n, 980_000n), 990_000n);
  assert.equal(midMark(1_000_000n, null), 1_000_000n);
  assert.equal(midMark(1_000_000n, 1_010_000n), 1_000_000n);
});
