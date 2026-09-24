import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  announcePositionChange, changeReflected, createPositionRefresher, pendingPositionChanges, positionInList,
  POSITION_REFRESH_POLL_MS, POSITION_REFRESH_WINDOW_MS, resetPositionChanges, subscribePositionChanges,
  type PositionChange, type Timers,
} from "../src/lib/frontend/position-refresh.ts";

const OWNER = "H6pLh8nFv1teY9G6JAVQuZQxeUvGfwYf1aPXHkDPDRph";
const PELOSI = "insiderindex-nancy-pelosi";

/** Manual clock: pending callbacks run only when the test advances time. */
function fakeTimers() {
  let now = 1_000_000;
  let seq = 0;
  const queue = new Map<number, { at: number; callback: () => void }>();
  const timers: Timers = {
    setTimeout: (callback, ms) => { const id = ++seq; queue.set(id, { at: now + ms, callback }); return id; },
    clearTimeout: handle => { queue.delete(handle as number); },
    now: () => now,
  };
  async function flush() { for (let i = 0; i < 10; i++) await Promise.resolve(); }
  async function advance(ms: number) {
    const target = now + ms;
    for (;;) {
      const next = [...queue.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > target) break;
      queue.delete(next[0]);
      now = next[1].at;
      next[1].callback();
      await flush();
    }
    now = target;
    await flush();
  }
  return { timers, advance, flush, scheduled: () => queue.size };
}

const change = (overrides: Partial<PositionChange> = {}): PositionChange => ({ indexId: PELOSI, owner: OWNER, mode: "deposit", sharesBeforeRaw: "0", signature: "sig", at: 1_000_000, ...overrides });

test("a change is reflected only when the read shows the share balance moved the way the signature moves it", () => {
  assert.equal(changeReflected(change(), null), false);
  assert.equal(changeReflected(change(), { sharesRaw: "0" }), false, "the pre-deposit balance is the stale read the captain saw");
  assert.equal(changeReflected(change(), { sharesRaw: "9993498" }), true);
  assert.equal(changeReflected(change({ mode: "withdraw", sharesBeforeRaw: "9993498" }), { sharesRaw: "9993498" }), false);
  assert.equal(changeReflected(change({ mode: "withdraw", sharesBeforeRaw: "9993498" }), { sharesRaw: "0" }), true);
  // The Positions list omits indexes the wallet holds nothing in: absence is a zero balance, not unknown.
  assert.deepEqual(positionInList([], PELOSI), { sharesRaw: "0" });
  assert.deepEqual(positionInList([{ indexId: PELOSI, sharesRaw: "5" }], PELOSI), { indexId: PELOSI, sharesRaw: "5" });
  assert.equal(positionInList(null, PELOSI), null);
});

test("a confirmed deposit refetches at once, polls every 3 s while the read is stale, and stops when the new balance shows", async () => {
  resetPositionChanges();
  const clock = fakeTimers();
  const reads = ["0", "0", "9993498"];
  let loads = 0;
  const applied: string[] = [];
  const updating: string[][] = [];
  const refresher = createPositionRefresher<{ sharesRaw: string }>({
    load: async () => ({ sharesRaw: reads[Math.min(loads++, reads.length - 1)]! }),
    apply: value => applied.push(value.sharesRaw),
    reflected: (value, c) => changeReflected(c, value),
    accepts: c => c.owner === OWNER && c.indexId === PELOSI,
    onUpdating: ids => updating.push(ids),
    timers: clock.timers,
  });
  refresher.track(change());
  await clock.flush();
  assert.equal(loads, 1, "the first re-read is immediate, not after a poll interval");
  assert.deepEqual(updating, [[PELOSI]], "stale numbers are replaced by Updating…");
  await clock.advance(POSITION_REFRESH_POLL_MS - 1);
  assert.equal(loads, 1);
  await clock.advance(1);
  assert.equal(loads, 2);
  await clock.advance(POSITION_REFRESH_POLL_MS);
  assert.equal(loads, 3);
  assert.deepEqual(applied, ["0", "0", "9993498"]);
  assert.deepEqual(updating.at(-1), [], "Updating… clears once the chain read shows the deposit");
  await clock.advance(POSITION_REFRESH_POLL_MS * 5);
  assert.equal(loads, 3, "no polling after the change is observed");
  assert.equal(clock.scheduled(), 0);
  refresher.dispose();
});

test("polling gives up after the refresh window and a failed read is retried, never treated as an observation", async () => {
  resetPositionChanges();
  const clock = fakeTimers();
  let loads = 0;
  const updating: string[][] = [];
  const refresher = createPositionRefresher<{ sharesRaw: string }>({
    load: async () => { loads++; if (loads === 1) throw new Error("rpc lagging"); return { sharesRaw: "0" }; },
    apply: () => {},
    reflected: (value, c) => changeReflected(c, value),
    accepts: () => true,
    onUpdating: ids => updating.push(ids),
    timers: clock.timers,
  });
  refresher.track(change());
  await clock.flush();
  assert.equal(loads, 1);
  await clock.advance(POSITION_REFRESH_WINDOW_MS + POSITION_REFRESH_POLL_MS);
  assert.equal(loads, 1 + POSITION_REFRESH_WINDOW_MS / POSITION_REFRESH_POLL_MS, "about one read every 3 s for 30 s");
  assert.deepEqual(updating.at(-1), [], "after the window the view stops claiming an update is imminent");
  assert.equal(clock.scheduled(), 0);
  // Focus still refetches once without restarting the poll.
  await refresher.refetch();
  assert.equal(clock.scheduled(), 0);
  refresher.dispose();
});

test("changes for another wallet or index are ignored; dispose stops every timer", async () => {
  resetPositionChanges();
  const clock = fakeTimers();
  let loads = 0;
  const refresher = createPositionRefresher<{ sharesRaw: string }>({
    load: async () => { loads++; return { sharesRaw: "0" }; },
    apply: () => {},
    reflected: (value, c) => changeReflected(c, value),
    accepts: c => c.owner === OWNER && c.indexId === PELOSI,
    onUpdating: () => {},
    timers: clock.timers,
  });
  refresher.track(change({ owner: "someone-else" }));
  refresher.track(change({ indexId: "idx-theme-mag7-caucus" }));
  await clock.advance(POSITION_REFRESH_POLL_MS * 3);
  assert.equal(loads, 0);
  refresher.track(change());
  await clock.flush();
  assert.equal(loads, 1);
  refresher.dispose();
  await clock.advance(POSITION_REFRESH_POLL_MS * 3);
  assert.equal(loads, 1);
  assert.equal(clock.scheduled(), 0);
});

test("VaultFlow's announcement reaches mounted views and views mounted later in the tab until a read settles it", () => {
  resetPositionChanges();
  const seen: PositionChange[] = [];
  const unsubscribe = subscribePositionChanges(c => seen.push(c));
  const announced = change({ at: Date.now() });
  announcePositionChange(announced);
  assert.deepEqual(seen, [announced], "the open position page / Positions list is told immediately");
  unsubscribe();
  // Navigating to Positions after the deposit: the fresh mount still knows to show Updating… and poll.
  assert.deepEqual(pendingPositionChanges(OWNER), [announced]);
  assert.deepEqual(pendingPositionChanges("someone-else"), []);
  assert.deepEqual(pendingPositionChanges(OWNER, announced.at + POSITION_REFRESH_WINDOW_MS), [], "expired changes drop out");
  resetPositionChanges();
});

test("a refresher that observes the change settles it for later mounts", async () => {
  resetPositionChanges();
  const clock = fakeTimers();
  const announced = change({ at: Date.now() });
  announcePositionChange(announced);
  const refresher = createPositionRefresher<{ sharesRaw: string }>({
    load: async () => ({ sharesRaw: "9993498" }),
    apply: () => {},
    reflected: (value, c) => changeReflected(c, value),
    accepts: () => true,
    onUpdating: () => {},
    timers: { ...clock.timers, now: () => Date.now() },
  });
  for (const pending of pendingPositionChanges(OWNER)) refresher.track(pending);
  await clock.flush();
  assert.deepEqual(pendingPositionChanges(OWNER), []);
  refresher.dispose();
});

test("every position view is wired to the refresh path and VaultFlow announces after confirmation", () => {
  const read = (path: string) => readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");
  const flow = read("components/vault-flow.tsx");
  assert.ok(flow.indexOf("announcePositionChange(") > flow.indexOf("await confirmSignature(signature, step.network)"), "announce only after the signature confirmed");
  for (const view of ["components/positions-table.tsx", "components/position-detail.tsx", "components/consumer-index.tsx", "components/thematic-index.tsx", "components/profile-view.tsx"]) {
    assert.match(read(view), /usePositionRefresh/, `${view} refetches after a confirmed signature and on focus`);
  }
  const hook = read("lib/frontend/use-position-refresh.ts");
  assert.match(hook, /addEventListener\("focus"/);
  assert.match(hook, /visibilitychange/);
  assert.match(read("components/positions-table.tsx"), /Updating…/);
  assert.match(read("components/position-detail.tsx"), /Updating…/);
});
