import assert from "node:assert/strict";
import { test } from "node:test";
import { PublicKey, TransactionMessage, VersionedTransaction, type ConnectionConfig } from "@solana/web3.js";
import { VAULTS_V3_PROGRAM_ID } from "@symmetry-hq/sdk/dist/constants.js";
import { RebalanceIntentLayout } from "@symmetry-hq/sdk/dist/layouts/intents/rebalanceIntent.js";
import { handleRpcProxy } from "../src/lib/rpc-proxy.ts";
import { createCycleReadConnection } from "../src/lib/frontend/cycle-rpc.ts";

const origin = "https://insiderindex.example", endpoint = origin + "/api/rpc";
const key = "SERVER-ONLY-TEST-CREDENTIAL-NOT-A-REAL-KEY";
const upstream = "https://rpc.example.invalid/?api-key=" + key;
const vault = "AwDFvjEPPwdF1YgXV8asNt6LeEFDduinYneCn6mHDAsh";
const sig = "1".repeat(64), blockhash = PublicKey.default.toBase58();
const discovery = { jsonrpc: "2.0", id: 7, method: "getProgramAccounts", params: [VAULTS_V3_PROGRAM_ID.toBase58(), {
  commitment: "confirmed", encoding: "base64", filters: [{ dataSize: RebalanceIntentLayout.span + 8 }, { memcmp: { offset: 8, bytes: vault, encoding: "base58" } }],
}] };
const request = (body: unknown) => new Request(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

// Execute the real web3 HTTP serialization -> app proxy -> synthetic upstream -> web3 parser.
// Neither transport can reach a network; a successful mock simulation is not financial evidence.
function bridge(result: (method: string, params: unknown[]) => unknown) {
  const calls: { method: string; params: unknown[] }[] = [];
  const fetcher: ConnectionConfig["fetch"] = async (url, init) => {
    assert.equal(String(url), endpoint);
    assert(!String(init?.body).includes(key));
    assert.equal(new Headers(init?.headers as HeadersInit).get("authorization"), null);
    const response = await handleRpcProxy(new Request(endpoint, init as RequestInit), {
      upstream: () => upstream, provider: "helius",
      fetcher: async (serverUrl, serverInit) => {
        assert.equal(String(serverUrl), upstream);
        assert.equal(serverInit?.redirect, "error");
        assert.equal(serverInit?.cache, "no-store");
        const call = JSON.parse(String(serverInit?.body)); calls.push(call);
        return Response.json({ jsonrpc: "2.0", id: call.id, result: result(call.method, call.params ?? []) });
      },
    });
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert(!(await response.clone().text()).includes(key));
    return response;
  };
  return { connection: createCycleReadConnection(origin, fetcher), calls };
}

test("same-origin cycle connection forwards the real SDK discovery/history/simulation shapes without a public RPC key", async () => {
  const { connection, calls } = bridge((method) => {
    switch (method) {
      case "getGenesisHash": return "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
      case "getProgramAccounts": return [];
      case "getSignaturesForAddress": return [{ signature: sig, slot: 42, err: null, memo: null, blockTime: null, confirmationStatus: "finalized" }];
      case "getBlock": return { blockhash, previousBlockhash: blockhash, parentSlot: 41, blockTime: null, signatures: [sig] };
      case "getBlockTime": return 1780000000;
      case "getTransaction": return null;
      case "getBalance": return { context: { slot: 42 }, value: 123 };
      case "simulateTransaction": return { context: { slot: 42 }, value: { err: null, logs: [], accounts: [null], unitsConsumed: 1 } };
      default: throw new Error("Unexpected mocked upstream method: " + method);
    }
  });
  assert.equal(connection.rpcEndpoint, endpoint);
  assert.equal(await connection.getGenesisHash(), "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d");
  assert.deepEqual(await connection.getProgramAccounts(VAULTS_V3_PROGRAM_ID, { commitment: "confirmed", filters: [
    { dataSize: RebalanceIntentLayout.span + 8 }, { memcmp: { offset: 8, bytes: vault } },
  ] }), []);
  assert.equal((await connection.getSignaturesForAddress(new PublicKey(vault), { limit: 100, minContextSlot: 42, before: sig }, "finalized"))[0].signature, sig);
  assert.equal((await connection.getSignaturesForAddress(new PublicKey(vault), { limit: 1, minContextSlot: 42 }, "finalized"))[0].signature, sig);
  assert.deepEqual((await connection.getBlockSignatures(42, "finalized")).signatures, [sig]);
  assert.equal(await connection.getBlockTime(42), 1780000000);
  assert.equal(await connection.getTransaction(sig, { commitment: "finalized", maxSupportedTransactionVersion: 0 }), null);
  assert.equal(await connection.getBalance(new PublicKey(vault), "confirmed"), 123);
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: PublicKey.default, recentBlockhash: blockhash, instructions: [] }).compileToV0Message());
  const simulated = await connection.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: false, commitment: "confirmed", minContextSlot: 42, accounts: { encoding: "base64", addresses: [vault] } });
  assert.equal(simulated.value.err, null);
  assert(tx.signatures.every(s => s.every(b => b === 0)));
  assert.equal(calls.length, 9);
  assert.equal(calls.filter(c => c.method === "sendTransaction").length, 0);
  assert.deepEqual(calls.find(c => c.method === "getProgramAccounts")!.params, discovery.params);
});

test("proxy refuses broad scans, nonfinalized/unbounded history and malformed/bad batches before touching the upstream", async () => {
  // Unknown-typed JSON mutations intentionally exercise the HTTP boundary, not TypeScript casts as evidence.
  const gpa = (config: Record<string, unknown>, program = VAULTS_V3_PROGRAM_ID.toBase58()) => ({ method: "getProgramAccounts", params: [program, config] });
  const config = discovery.params[1] as Record<string, unknown>;
  const history = { commitment: "finalized", limit: 100, minContextSlot: 42 };
  const refused: unknown[] = [
    null, 1, "getGenesisHash", {}, [], [null], Array.from({ length: 21 }, () => ({ method: "getGenesisHash" })),
    { method: "getGenesisHash", params: ["extra"] }, { method: "getBlockTime", params: [-1] }, { method: "getBlockTime", params: [1.5] },
    { method: "getBlocks", params: [0, 1000] },
    gpa({ ...config, filters: [] }), gpa(config, PublicKey.default.toBase58()), gpa({ ...config, encoding: "jsonParsed" }),
    gpa({ ...config, commitment: "processed" }), gpa({ ...config, dataSlice: { offset: 0, length: 1 } }),
    gpa({ ...config, filters: [{ dataSize: RebalanceIntentLayout.span + 9 }, { memcmp: { offset: 8, bytes: vault } }] }),
    gpa({ ...config, filters: [{ dataSize: RebalanceIntentLayout.span + 8 }, { memcmp: { offset: 0, bytes: vault } }] }),
    gpa({ ...config, filters: [{ dataSize: RebalanceIntentLayout.span + 8 }, { memcmp: { offset: 8, bytes: "not-a-key" } }] }),
    { method: "getSignaturesForAddress", params: [vault, { ...history, limit: 101 }] },
    { method: "getSignaturesForAddress", params: [vault, { ...history, commitment: "confirmed" }] },
    { method: "getSignaturesForAddress", params: [vault, { limit: 100, commitment: "finalized" }] },
    { method: "getSignaturesForAddress", params: [vault, { ...history, before: "invalid" }] },
    { method: "getSignaturesForAddress", params: [vault, { ...history, until: sig }] },
    { method: "getBlock", params: [42, { commitment: "confirmed", transactionDetails: "signatures", rewards: false }] },
    { method: "getBlock", params: [42, { commitment: "finalized", transactionDetails: "full", rewards: false }] },
    { method: "getBlock", params: [42, { commitment: "finalized", transactionDetails: "signatures", rewards: true }] },
    [discovery, { method: "requestAirdrop", params: [vault, 1] }],
  ];
  let touched = 0;
  const options = { upstream: () => { touched++; return upstream; }, provider: "helius" as const, fetcher: async () => { touched++; throw new Error("No upstream call permitted"); } };
  for (const body of refused) assert.equal((await handleRpcProxy(request(body), options)).status, 403, JSON.stringify(body));
  assert.equal((await handleRpcProxy(new Request(endpoint, { method: "POST", body: "{" }), options)).status, 400);
  assert.equal(touched, 0);
});

test("proxy preserves existing relay and batch payloads but never signs or returns server credentials", async () => {
  const calls = [{ jsonrpc: "2.0", id: "a", method: "getGenesisHash", params: [] }, { jsonrpc: "2.0", id: "b", method: "sendTransaction", params: ["MOCK-ONLY-NOT-A-WIRE", { encoding: "base64" }] }];
  let forwarded = 0;
  const options = { upstream: () => upstream, provider: "helius" as const, fetcher: async (_url: unknown, init?: RequestInit) => {
    forwarded++; assert.deepEqual(JSON.parse(String(init?.body)), calls);
    return Response.json([{ jsonrpc: "2.0", id: "a", result: blockhash }, { jsonrpc: "2.0", id: "b", error: { code: -32602, message: "Invalid mock wire" } }]);
  } };
  const response = await handleRpcProxy(request(calls), options);
  assert.equal(response.status, 200); assert.equal(forwarded, 1);
  assert.equal(response.headers.get("X-Stocklana-Rpc"), "helius");
  assert.deepEqual((await response.json()).map((r: { id: string }) => r.id), ["a", "b"]);
  for (const fetcher of [
    async () => { throw new Error("Failed at " + upstream); },
    async () => new Response("Upstream diagnostic containing " + key, { status: 401 }),
  ]) {
    const refused = await handleRpcProxy(request({ method: "getGenesisHash" }), { ...options, fetcher });
    assert.equal(refused.status, 502);
    assert.deepEqual(await refused.json(), { error: "RPC upstream unavailable." });
  }
});

test("cycle read connection accepts only an HTTP origin, not a secret-bearing RPC URL", () => {
  assert.equal(createCycleReadConnection("http://localhost:3000").rpcEndpoint, "http://localhost:3000/api/rpc");
  for (const invalid of [upstream, "https://user:secret@insiderindex.example", origin + "/other", "wss://insiderindex.example", origin + "#fragment"]) {
    assert.throws(() => createCycleReadConnection(invalid), /CYCLE_RPC_ORIGIN_REQUIRED/);
  }
});
