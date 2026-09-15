import test from "node:test";
import assert from "node:assert/strict";
import {
  isPersonFollowed,
  listFollowedPersonIds,
  personFollowKey,
  subscribeToPersonFollows,
  PERSON_FOLLOW_EVENT,
} from "../src/lib/frontend/watchlist.ts";

// Device-local watchlist replaced the deleted server-side follow store; this
// exercises its real getItem/setItem/event-fanout behavior, not its source text.
function installFakeBrowserGlobals() {
  const storage: Record<string, string> = {};
  Object.defineProperty(storage, "getItem", { value: (key: string) => (key in storage ? storage[key] : null), enumerable: false });
  Object.defineProperty(storage, "setItem", { value: (key: string, value: string) => { storage[key] = String(value); }, enumerable: false });
  Object.defineProperty(storage, "removeItem", { value: (key: string) => { delete storage[key]; }, enumerable: false });
  (globalThis as unknown as { localStorage: unknown }).localStorage = storage;

  class FakeWindow extends EventTarget {}
  (globalThis as unknown as { window: unknown }).window = new FakeWindow();

  return storage;
}

test("watchlist add/remove round-trips through the real localStorage-backed store", async () => {
  installFakeBrowserGlobals();

  assert.equal(isPersonFollowed("P000197"), false);
  assert.deepEqual(listFollowedPersonIds(), []);

  localStorage.setItem(personFollowKey("P000197"), "true");
  assert.equal(isPersonFollowed("P000197"), true);
  assert.deepEqual(listFollowedPersonIds(), ["P000197"]);

  localStorage.setItem(personFollowKey("insider-0001043298"), "true");
  assert.deepEqual(new Set(listFollowedPersonIds()), new Set(["P000197", "insider-0001043298"]));

  localStorage.setItem(personFollowKey("P000197"), "false");
  assert.equal(isPersonFollowed("P000197"), false);
  assert.deepEqual(listFollowedPersonIds(), ["insider-0001043298"]);
});

test("subscribeToPersonFollows notifies on the same-tab change event and unsubscribes cleanly", async () => {
  installFakeBrowserGlobals();

  let calls = 0;
  const unsubscribe = subscribeToPersonFollows(() => { calls += 1; });

  window.dispatchEvent(new Event(PERSON_FOLLOW_EVENT));
  assert.equal(calls, 1);

  window.dispatchEvent(new Event("storage"));
  assert.equal(calls, 2);

  unsubscribe();
  window.dispatchEvent(new Event(PERSON_FOLLOW_EVENT));
  assert.equal(calls, 2, "no further notifications should arrive after unsubscribing");
});

test("a broken localStorage (e.g. private-mode Safari) fails closed instead of throwing", async () => {
  class ThrowingStorage {
    getItem() { throw new Error("storage disabled"); }
    setItem() { throw new Error("storage disabled"); }
  }
  (globalThis as unknown as { localStorage: unknown }).localStorage = new ThrowingStorage();
  class FakeWindow extends EventTarget {}
  (globalThis as unknown as { window: unknown }).window = new FakeWindow();

  assert.equal(isPersonFollowed("P000197"), false);
  assert.deepEqual(listFollowedPersonIds(), []);
});
