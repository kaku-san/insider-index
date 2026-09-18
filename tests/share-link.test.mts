import assert from "node:assert/strict";
import test from "node:test";

const { shareLink } = await import("../src/lib/frontend/share-link.ts");
const data = { title: "Example Index · InsiderIndex", text: "Person index on InsiderIndex.xyz", url: "https://insiderindex.xyz/indexes/example" };

test("share card reports a native share only after the browser accepts it", async () => {
  let shared = false;
  assert.equal(await shareLink({ share: async value => { shared = value.url === data.url; }, copy: async () => assert.fail("copy should not run") }, data), "shared");
  assert.equal(shared, true);
});

test("share card falls back to copy when native sharing is unavailable or rejects", async () => {
  let copied = "";
  assert.equal(await shareLink({ copy: async value => { copied = value; } }, data), "copied");
  assert.equal(copied, data.url);
  assert.equal(await shareLink({ share: async () => { throw new Error("not supported"); }, copy: async () => {} }, data), "copied");
});

test("share cancellation and clipboard denial never claim success", async () => {
  assert.equal(await shareLink({ share: async () => { throw { name: "AbortError" }; }, copy: async () => assert.fail("copy should not run after cancellation") }, data), "cancelled");
  assert.equal(await shareLink({ copy: async () => { throw new Error("denied"); } }, data), "manual");
});
