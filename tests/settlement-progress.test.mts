import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  noticedShareArrival, plainStatusForOperation, positionNeedsListen, positionsNeedListen, SETTLEMENT_STATUSES,
  settlementDetail, settlementView, sharesDecreasedAfterSignature, sharesIncreasedAfterSignature,
} from "../src/lib/frontend/settlement-progress.ts";

register("./support/ui-loader.mjs", import.meta.url);
const { SettlementListen } = await import("../src/components/settlement-listen.tsx");

const deposit = (phase: string, sharesRaw = "0") => ({
  sharesRaw,
  pendingOperations: [{ kind: "deposit", phase, complete: false, blockers: phase === "FAILED" ? ["This deposit did not finish the basket. It is not shares."] : ["Deposit pending settlement"] }],
});
const withdraw = (phase: string, sharesRaw = "0") => ({
  sharesRaw,
  pendingOperations: [{ kind: "withdraw", phase, complete: false, blockers: ["Cash out pending settlement"] }],
});

test("settlement status is only the observed plain words", () => {
  assert.deepEqual(SETTLEMENT_STATUSES, ["pending", "filling", "shares received", "cash out settling", "failed"]);
  assert.equal(plainStatusForOperation({ kind: "deposit", phase: "PRICING" }), "pending");
  assert.equal(plainStatusForOperation({ kind: "deposit", phase: "AWAITING_LOCK" }), "pending");
  assert.equal(plainStatusForOperation({ kind: "deposit", phase: "AUCTION" }), "filling");
  assert.equal(plainStatusForOperation({ kind: "deposit", phase: "CLEANUP" }), "filling");
  assert.equal(plainStatusForOperation({ kind: "deposit", phase: "FAILED" }), "failed");
  assert.equal(plainStatusForOperation({ kind: "withdraw", phase: "AUCTION" }), "cash out settling");
  assert.equal(plainStatusForOperation({ kind: "withdraw", phase: "PRICING" }), "cash out settling");
});

test("a deposit listen follows the position read and does not treat dust or a price update as progress", () => {
  assert.equal(sharesIncreasedAfterSignature("3", { sharesRaw: "3" }), false);
  assert.equal(sharesIncreasedAfterSignature("3", { sharesRaw: "4" }), true);
  assert.deepEqual(settlementView({ mode: "deposit", sharesBeforeRaw: "3", position: null }), { status: "pending", listening: true, cashOutFinished: false });
  assert.deepEqual(settlementView({ mode: "deposit", sharesBeforeRaw: "3", position: deposit("PRICING") }), { status: "pending", listening: true, cashOutFinished: false });
  assert.deepEqual(settlementView({ mode: "deposit", sharesBeforeRaw: "3", position: deposit("AUCTION", "3") }), { status: "filling", listening: true, cashOutFinished: false });
  assert.deepEqual(settlementView({ mode: "deposit", sharesBeforeRaw: "3", position: { sharesRaw: "4" } }), { status: "shares received", listening: false, cashOutFinished: false });
  assert.deepEqual(settlementView({ mode: "deposit", sharesBeforeRaw: "3", position: deposit("FAILED", "3") }), { status: "failed", listening: false, cashOutFinished: false });
  assert.equal(settlementDetail(settlementView({ mode: "deposit", sharesBeforeRaw: "3", position: deposit("FAILED", "3") }), deposit("FAILED", "3"), "deposit"), "This deposit did not finish the basket. It is not shares.");
  assert.deepEqual(settlementView({ mode: "deposit", sharesBeforeRaw: "3", position: deposit("AUCTION", "3"), timedOut: true }), { status: "failed", listening: false, cashOutFinished: false });
  assert.equal(settlementView({ mode: "deposit", sharesBeforeRaw: "3", position: { sharesRaw: "4" }, timedOut: true }).status, "shares received");
});

test("a cash-out listen stays on the position read until the pending withdraw clears or the balance is gone", () => {
  assert.equal(sharesDecreasedAfterSignature("10", { sharesRaw: "10" }), false);
  assert.equal(sharesDecreasedAfterSignature("10", { sharesRaw: "4" }), true);
  assert.deepEqual(settlementView({ mode: "withdraw", sharesBeforeRaw: "10", position: null }), { status: "pending", listening: true, cashOutFinished: false });
  assert.deepEqual(settlementView({ mode: "withdraw", sharesBeforeRaw: "10", position: withdraw("AUCTION", "0") }), { status: "cash out settling", listening: true, cashOutFinished: false });
  assert.deepEqual(settlementView({ mode: "withdraw", sharesBeforeRaw: "10", position: { sharesRaw: "4" } }), { status: "cash out settling", listening: true, cashOutFinished: false });
  assert.equal(settlementView({ mode: "withdraw", sharesBeforeRaw: "10", position: { sharesRaw: "4" } }).cashOutFinished, false, "a partial share debit is not a finished cash out");
  assert.deepEqual(settlementView({ mode: "withdraw", sharesBeforeRaw: "10", position: { sharesRaw: "0" }, sawWithdrawPending: true }), { status: "cash out settling", listening: false, cashOutFinished: true });
  assert.equal(settlementView({ mode: "withdraw", sharesBeforeRaw: "10", position: { sharesRaw: "0" } }).cashOutFinished, true);
  assert.equal(settlementView({ mode: "withdraw", sharesBeforeRaw: "10", position: { sharesRaw: "0" }, sawWithdrawPending: true }).status, "cash out settling");
  assert.notEqual(settlementView({ mode: "withdraw", sharesBeforeRaw: "10", position: { sharesRaw: "0" } }).status, "shares received");
  assert.deepEqual(settlementView({ mode: "withdraw", sharesBeforeRaw: "10", position: withdraw("FAILED", "10") }), { status: "failed", listening: false, cashOutFinished: false });
  assert.equal(settlementView({ mode: "withdraw", sharesBeforeRaw: "10", position: withdraw("AUCTION", "0"), timedOut: true }).listening, true, "an open cash-out is not failed because the deposit backstop elapsed");
});

test("positions keep listening only while a non-failed pending operation is visible", () => {
  assert.equal(positionNeedsListen(deposit("AUCTION")), true);
  assert.equal(positionNeedsListen(deposit("FAILED")), false);
  assert.equal(positionNeedsListen({ pendingOperations: [] }), false);
  assert.equal(positionsNeedListen([deposit("FAILED"), withdraw("AUCTION")]), true);
  assert.equal(positionsNeedListen([deposit("FAILED")]), false);
  assert.equal(noticedShareArrival(deposit("AUCTION", "0"), { sharesRaw: "5" }), true);
  assert.equal(noticedShareArrival(deposit("AUCTION", "3"), deposit("AUCTION", "4")), false);
  assert.equal(noticedShareArrival({ sharesRaw: "1" }, { sharesRaw: "2" }), false);
});

test("the listen card shows a loader only while listening and does not fake a percent", () => {
  for (const status of SETTLEMENT_STATUSES) {
    const listening = status === "pending" || status === "filling" || status === "cash out settling";
    const html = renderToStaticMarkup(createElement(SettlementListen, { status, listening, detail: "Observed position." }));
    assert.match(html, new RegExp(`data-settlement-status="${status}"`));
    assert.match(html, new RegExp(`>${status}<`));
    assert.equal(html.includes("loader"), listening);
    assert.doesNotMatch(html, /reload|step \d|% complete|\d+%/i);
  }
  const finished = renderToStaticMarkup(createElement(SettlementListen, { status: "shares received", listening: false, detail: "Your share balance increased after this signature." }));
  assert.match(finished, /data-listening="false"/);
  assert.doesNotMatch(finished, /loader/);
});
