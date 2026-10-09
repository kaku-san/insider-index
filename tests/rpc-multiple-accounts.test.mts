import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { promisify } from "node:util";
import { Connection, PublicKey } from "@solana/web3.js";
import { chunkedRpcFetch, rpcMaxMultipleAccounts } from "../src/lib/rpc-multiple-accounts.ts";
import { throttledFetch } from "../src/lib/nav-vault/rpc-throttle.ts";
import { handleRpcProxy } from "../src/lib/rpc-proxy.ts";
import { handleNavReadiness } from "../src/lib/nav-vault/server.ts";
import { updatePricesIx } from "../src/lib/nav-vault/program.ts";
import { navVaultVm, seedIndex } from "./support/nav-vault-vm.mts";

const url = "https://rpc.example.invalid/";
const keys = Array.from({ length: 13 }, () => PublicKey.unique().toBase58());
const call = { jsonrpc: "2.0", id: "accounts", method: "getMultipleAccounts", params: [keys, { commitment: "confirmed", encoding: "base64", minContextSlot: 7 }] };
const post = (body: unknown) => new Request("https://app.example/api/rpc", { method: "POST", body: JSON.stringify(body) });
const reply = (id: unknown, value: unknown[], slot = 10) => Response.json({ jsonrpc: "2.0", id, result: { context: { slot }, value } });

test("account limits default to five, are configurable, and reject invalid configuration", () => {
  assert.equal(rpcMaxMultipleAccounts(""), 5);
  assert.equal(rpcMaxMultipleAccounts("  "), 5);
  assert.equal(rpcMaxMultipleAccounts(" 2 "), 2);
  assert.equal(rpcMaxMultipleAccounts("100"), 100);
  for (const bad of ["0", "-1", "1.5", "NaN", "Infinity", "101"]) assert.throws(() => rpcMaxMultipleAccounts(bad), /integer from 1 to 100/);
});

test("web3 account reads chunk and reassemble duplicates/nulls in order with the oldest context", async () => {
  for (const maxMultipleAccounts of [5, 2]) {
    const requested = [...keys.slice(0, 12), keys[0]!];
    const seen: string[][] = [];
    const transport = chunkedRpcFetch({ maxMultipleAccounts, fetchImpl: async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      const chunk: string[] = body.params[0];
      seen.push(chunk);
      assert.ok(chunk.length <= maxMultipleAccounts, "provider limit is enforced before each RPC request");
      assert.equal(body.params[1].commitment, "confirmed");
      assert.equal(body.params[1].minContextSlot, 7);
      return reply(body.id, chunk.map(key => key === keys[3] ? null : {
        data: [Buffer.from(key).toString("base64"), "base64"], owner: PublicKey.default.toBase58(), lamports: 1, executable: false, rentEpoch: 0,
      }), seen.length === 2 ? 8 : 10);
    } });
    const connection = new Connection(url, { fetch: transport });
    const result = await connection.getMultipleAccountsInfoAndContext(requested.map(key => new PublicKey(key)), { commitment: "confirmed", minContextSlot: 7 });
    assert.deepEqual(seen.flat(), requested);
    assert.equal(seen.length, Math.ceil(requested.length / maxMultipleAccounts));
    assert.equal(result.context.slot, 8);
    assert.deepEqual(result.value.map(account => account?.data.toString() ?? null), requested.map(key => key === keys[3] ? null : key));
  }
});

test("each keeper chunk remains paced and retries only its own 429", async () => {
  let clock = 0;
  const starts: number[] = [], seen: string[][] = [];
  const transport = throttledFetch({ minIntervalMs: 100, now: () => clock, sleep: async ms => { clock += ms; }, fetchImpl: async (_url, init) => {
    starts.push(clock);
    const body = JSON.parse(String(init?.body));
    seen.push(body.params[0]);
    if (seen.length === 2) return new Response(null, { status: 429, headers: { "retry-after": "1" } });
    return reply(body.id, body.params[0].map(() => null));
  } });
  const result = await (await transport(url, { method: "POST", body: JSON.stringify(call) })).json();
  assert.equal(result.result.value.length, keys.length);
  assert.deepEqual(seen.map(chunk => chunk.length), [5, 5, 5, 3]);
  assert.deepEqual(seen[1], seen[2], "only the rate-limited chunk is retried");
  assert.deepEqual(starts, [0, 100, 1100, 1200]);
});

test("a failed or malformed later chunk never returns a partial account result", async () => {
  for (const failure of ["rpc", "http", "length", "slot", "id"] as const) {
    let calls = 0;
    const transport = chunkedRpcFetch({ fetchImpl: async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      if (++calls === 1) return reply(body.id, body.params[0].map(() => null));
      if (failure === "rpc") return Response.json({ jsonrpc: "2.0", id: body.id, error: { code: -32615, message: "plan limit" } });
      if (failure === "http") return new Response("unavailable", { status: 413 });
      if (failure === "length") return reply(body.id, []);
      if (failure === "slot") return reply(body.id, body.params[0].map(() => null), -1);
      return reply("wrong-id", body.params[0].map(() => null));
    } });
    const response = transport(url, { method: "POST", body: JSON.stringify(call) });
    if (failure === "rpc") assert.equal((await (await response).json()).error.code, -32615);
    else if (failure === "http") assert.equal((await response).status, 413);
    else await assert.rejects(response, /Invalid getMultipleAccounts/);
    assert.equal(calls, 2, "no later chunks or fabricated values after failure");
  }
});

test("proxy splits mixed browser batches, preserves IDs/configuration, and relays other methods once", async () => {
  const relay = { jsonrpc: "2.0", id: "relay", method: "sendTransaction", params: ["MOCK-NOT-A-TRANSACTION", { encoding: "base64" }] };
  const seen: Record<string, unknown>[] = [];
  const response = await handleRpcProxy(post([call, relay]), { upstream: () => url, provider: "rpc", maxMultipleAccounts: 3, fetcher: async (_url, init) => {
    const body = JSON.parse(String(init?.body)); seen.push(body);
    if (body.method === "sendTransaction") { assert.deepEqual(body, relay); return Response.json({ jsonrpc: "2.0", id: body.id, result: "synthetic-signature" }); }
    assert.ok(body.params[0].length <= 3);
    assert.deepEqual(body.params[1], call.params[1]);
    return reply(body.id, body.params[0].map((key: string) => ({ key })));
  } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("X-Stocklana-Rpc"), "rpc");
  const body = await response.json();
  assert.deepEqual(body.map((item: { id: string }) => item.id), ["accounts", "relay"]);
  assert.deepEqual(body[0].result.value.map((item: { key: string }) => item.key), keys);
  assert.equal(seen.filter(item => item.method === "sendTransaction").length, 1);
});

test("proxy keeps credential redaction after chunking and bounds total account fan-out", async () => {
  let touched = 0;
  const options = { upstream: () => "https://rpc.example.invalid/SECRET-PATH-TOKEN/", provider: "rpc" as const, fetcher: async (_url: unknown, init?: RequestInit) => {
    touched++;
    const body = JSON.parse(String(init?.body));
    if (touched === 1) return reply(body.id, body.params[0].map(() => null));
    return Response.json({ jsonrpc: "2.0", id: body.id, error: { code: -1, message: "SECRET-PATH-TOKEN invalid" } });
  } };
  const failed = await handleRpcProxy(post(call), options);
  assert.equal(failed.status, 502);
  assert.deepEqual(await failed.json(), { error: "RPC upstream unavailable." });
  touched = 0;
  const refused = await handleRpcProxy(post({ ...call, params: [Array(101).fill(keys[0])] }), options);
  assert.equal(refused.status, 403);
  assert.equal(touched, 0);
});

test("default NAV readiness transport reads a seven-leg vault without exceeding the configured cap", async t => {
  const vm = navVaultVm(), seeded = seedIndex(vm, "idx-chunked-readiness", { legCount: 7 });
  vm.must(vm.send([updatePricesIx(vm.vault(seeded.indexId), seeded.keeper.publicKey, seeded.prices)], seeded.keeper));
  vm.advance(1);
  const env = { STOCKLANA_NAV_VAULT_NETWORK: "devnet", STOCKLANA_NAV_VAULT_RPC_URL: url, STOCKLANA_NAV_VAULT_PROGRAM_ID: "", STOCKLANA_NAV_VAULT_INDEXES: "", STOCKLANA_NAV_VAULT_DISABLED: "0", RPC_MAX_MULTIPLE_ACCOUNTS: "3", SUPABASE_SERVICE_ROLE_KEY: "" };
  for (const [name, value] of Object.entries(env)) {
    const previous = process.env[name];
    t.after(() => { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; });
    process.env[name] = value;
  }
  const sizes: number[] = [];
  const wireInfo = (key: string) => {
    const info = vm.info(new PublicKey(key));
    return info ? { ...info, owner: info.owner.toBase58(), data: [info.data.toString("base64"), "base64"] } : null;
  };
  t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
    assert.equal(String(_url), url);
    const body = JSON.parse(String(init?.body));
    let value;
    if (body.method === "getAccountInfo") value = wireInfo(body.params[0]);
    else {
      assert.equal(body.method, "getMultipleAccounts");
      sizes.push(body.params[0].length);
      assert.ok(body.params[0].length <= 3);
      value = body.params[0].map(wireInfo);
    }
    return Response.json({ jsonrpc: "2.0", id: body.id, result: { context: { slot: Number(vm.svm.getClock().slot) }, value } });
  });
  const response = await handleNavReadiness(seeded.indexId);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).phase, "LIVE");
  assert.deepEqual(sizes, [3, 3, 3]);
});

test("keeper CLI discovery uses bounded reads without signing or contacting a live provider", async () => {
  const sizes: number[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8"); request.on("data", chunk => { body += chunk; });
    request.on("end", () => {
      const call = JSON.parse(body), chunk = call.params[0]; sizes.push(chunk.length);
      response.writeHead(chunk.length <= 5 ? 200 : 413, { "content-type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: call.id, result: { context: { slot: 1 }, value: chunk.map(() => null) } }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address(); assert.ok(address && typeof address !== "string");
    await promisify(execFile)(process.execPath, ["--experimental-strip-types", "scripts/nav-vault-cli.mts", "keeper", "--network", "devnet", "--rpc", `http://127.0.0.1:${address.port}`, "--indexes", Array.from({ length: 8 }, (_, i) => `missing-${i}`).join(",")], { env: { ...process.env, RPC_MAX_MULTIPLE_ACCOUNTS: "5" } });
    assert.deepEqual(sizes, [5, 3]);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
