import assert from "node:assert/strict";
import test from "node:test";
import { ResourceRequestFence } from "../src/lib/frontend/resource-request-fence.ts";

test("an external replacement fences out an older resource response", async () => {
  const fence = new ResourceRequestFence();
  let resolveRead!: (value: string) => void;
  const staleRead = new Promise<string>(resolve => { resolveRead = resolve; });
  const requestGeneration = fence.begin();
  let data = "cached";
  let loading = true;

  const request = staleRead.then(value => {
    if (fence.isCurrent(requestGeneration)) data = value;
  }).finally(() => {
    if (fence.isCurrent(requestGeneration)) loading = false;
  });

  fence.invalidate();
  data = "post-signature";
  loading = false;
  resolveRead("stale");
  await request;

  assert.equal(data, "post-signature");
  assert.equal(loading, false);
});
