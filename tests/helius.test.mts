import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";
import { getHeliusRpcUrl, heliusConfigured } from "../src/lib/helius.ts";

register("./support/ui-loader.mjs", import.meta.url);
const { getAdapterStatus, getRuntimeModes } = await import("../src/lib/health.ts");
const { GET, POST } = await import("../src/app/api/rpc/route.ts");

const customUrl = "https://rpc.example.invalid/SYNTHETIC-PRIVATE-PATH/";
const heliusKey = "SYNTHETIC-HELIUS-KEY";
const publicUrl = "https://api.mainnet-beta.solana.com";
const cases = [
  { name: "server RPC overrides an exhausted Helius key", rpc: customUrl, helius: heliusKey, url: customUrl, provider: "rpc", configured: true },
  { name: "server RPC works without a Helius key", rpc: customUrl, helius: undefined, url: customUrl, provider: "rpc", configured: true },
  { name: "Helius remains the fallback without an override", rpc: undefined, helius: heliusKey, url: `https://mainnet.helius-rpc.com/?api-key=${heliusKey}`, provider: "helius", configured: true },
  { name: "empty override keeps the Helius fallback", rpc: "", helius: heliusKey, url: `https://mainnet.helius-rpc.com/?api-key=${heliusKey}`, provider: "helius", configured: true },
  { name: "public mainnet remains the keyless fallback", rpc: undefined, helius: undefined, url: publicUrl, provider: "public", configured: false },
  { name: "empty settings keep the public fallback", rpc: "", helius: "", url: publicUrl, provider: "public", configured: false },
];

for (const scenario of cases) {
  test(scenario.name, async t => {
    const env = {
      SOLANA_RPC_URL: scenario.rpc,
      HELIUS_API_KEY: scenario.helius,
      // A browser-visible variable must never select the server's credential.
      NEXT_PUBLIC_SOLANA_RPC_URL: "https://ignored.example.invalid/",
    };
    for (const [name, value] of Object.entries(env)) {
      const previous = process.env[name];
      t.after(() => { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; });
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }

    assert.equal(getHeliusRpcUrl(), scenario.url);
    assert.equal(heliusConfigured(), scenario.configured);
    const adapters = getAdapterStatus();
    assert.equal(adapters.rpc, scenario.configured);
    assert.equal(adapters.helius, Boolean(scenario.helius), "Helius credential presence remains distinct from RPC readiness");
    assert.equal(getRuntimeModes().rpc, scenario.provider);
    assert.deepEqual(await (await GET()).json(), { rpc: scenario.provider });

    const call = { jsonrpc: "2.0", id: 1, method: "getBalance", params: ["11111111111111111111111111111111"] };
    const result = { jsonrpc: "2.0", id: 1, result: { context: { slot: 42 }, value: 123 } };
    const fetcher = t.mock.method(globalThis, "fetch", async (url: unknown, init?: RequestInit) => {
      assert.equal(String(url), scenario.url);
      assert.deepEqual(JSON.parse(String(init?.body)), call);
      return Response.json(result);
    });
    const response = await POST(new Request("https://insiderindex.example/api/rpc", { method: "POST", body: JSON.stringify(call) }));
    assert.equal(fetcher.mock.callCount(), 1);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("X-Stocklana-Rpc"), scenario.provider);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.deepEqual(await response.json(), result);
  });
}
