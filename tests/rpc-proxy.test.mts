import assert from "node:assert/strict";
import { test } from "node:test";
import { Connection, PublicKey, TransactionMessage, VersionedTransaction, type ConnectionConfig } from "@solana/web3.js";
import bs58 from "bs58";
import { handleRpcProxy } from "../src/lib/rpc-proxy.ts";

const origin = "https://insiderindex.example", endpoint = origin + "/api/rpc";
const key = "SERVER-ONLY-TEST-CREDENTIAL-NOT-A-REAL-KEY";
const upstream = "https://rpc.example.invalid/?api-key=" + key;
const vault = "2w5g5aXmQj6o1cZSYbpV6R6rdK9KK7zAeJJRZu9PseM6";
const sig = bs58.encode(new Uint8Array(64).fill(1)), blockhash = PublicKey.default.toBase58();
const request = (body: unknown) => new Request(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

// Real web3 serialization -> app proxy -> synthetic upstream -> web3 parser, offline.
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
  return { connection: new Connection(endpoint, { commitment: "confirmed", fetch: fetcher }), calls };
}

test("same-origin RPC forwards wallet reads and simulation without a public RPC key", async () => {
  const { connection, calls } = bridge(method => {
    switch (method) {
      case "getGenesisHash": return "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
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
  assert.equal((await connection.getSignaturesForAddress(new PublicKey(vault), { limit: 100, minContextSlot: 42, before: sig }, "finalized"))[0].signature, sig);
  assert.equal((await connection.getSignaturesForAddress(new PublicKey(vault), { limit: 1, minContextSlot: 42 }, "finalized"))[0].signature, sig);
  assert.deepEqual((await connection.getBlockSignatures(42, "finalized")).signatures, [sig]);
  assert.equal(await connection.getBlockTime(42), 1780000000);
  assert.equal(await connection.getTransaction(sig, { commitment: "finalized", maxSupportedTransactionVersion: 0 }), null);
  assert.equal(await connection.getBalance(new PublicKey(vault), "confirmed"), 123);
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: PublicKey.default, recentBlockhash: blockhash, instructions: [] }).compileToV0Message());
  assert.equal((await connection.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: false, commitment: "confirmed", minContextSlot: 42, accounts: { encoding: "base64", addresses: [vault] } })).value.err, null);
  assert(tx.signatures.every(s => s.every(b => b === 0)));
  assert.equal(calls.length, 8);
  assert.equal(calls.filter(c => c.method === "sendTransaction").length, 0);
});

test("proxy refuses program scans, unbounded history and malformed batches before touching upstream", async () => {
  const rpc = (call: Record<string, unknown>) => ({ jsonrpc: "2.0", id: 1, ...call });
  const history = { commitment: "finalized", limit: 100, minContextSlot: 42 };
  const refused: unknown[] = [
    null, 1, "getGenesisHash", {}, [], [null], Array.from({ length: 21 }, () => ({ method: "getGenesisHash" })),
    { method: "getBalance", params: [] },
    { jsonrpc: "1.0", id: 1, method: "getGenesisHash", params: [] },
    { jsonrpc: "2.0", id: {}, method: "getGenesisHash", params: [] },
    { jsonrpc: "2.0", id: 1, method: "getGenesisHash", params: "invalid" },
    rpc({ method: "getGenesisHash", params: ["extra"] }), rpc({ method: "getBlockTime", params: [-1] }), rpc({ method: "getBlockTime", params: [1.5] }),
    rpc({ method: "getBlocks", params: [0, 1000] }),
    rpc({ method: "getProgramAccounts", params: [vault, { commitment: "confirmed", encoding: "base64", filters: [] }] }),
    rpc({ method: "getSignaturesForAddress", params: [vault, { ...history, limit: 101 }] }),
    rpc({ method: "getSignaturesForAddress", params: [vault, { ...history, commitment: "confirmed" }] }),
    rpc({ method: "getSignaturesForAddress", params: [vault, { limit: 100, commitment: "finalized" }] }),
    rpc({ method: "getSignaturesForAddress", params: [vault, { ...history, before: "invalid" }] }),
    rpc({ method: "getSignaturesForAddress", params: [vault, { ...history, until: sig }] }),
    rpc({ method: "getBlock", params: [42, { commitment: "confirmed", transactionDetails: "signatures", rewards: false }] }),
    rpc({ method: "getBlock", params: [42, { commitment: "finalized", transactionDetails: "full", rewards: false }] }),
    rpc({ method: "getBlock", params: [42, { commitment: "finalized", transactionDetails: "signatures", rewards: true }] }),
    [rpc({ method: "getGenesisHash" }), rpc({ method: "requestAirdrop", params: [vault, 1] })],
  ];
  let touched = 0;
  const options = { upstream: () => { touched++; return upstream; }, provider: "helius" as const, fetcher: async () => { touched++; throw new Error("No upstream call permitted"); } };
  for (const body of refused) assert.equal((await handleRpcProxy(request(body), options)).status, 403, JSON.stringify(body));
  assert.equal((await handleRpcProxy(new Request(endpoint, { method: "POST", body: "{" }), options)).status, 400);
  assert.equal(touched, 0);
});

test("proxy preserves relay and batch payloads but never signs or returns server credentials", async () => {
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
    const refused = await handleRpcProxy(request({ jsonrpc: "2.0", id: 1, method: "getGenesisHash", params: [] }), { ...options, fetcher });
    assert.equal(refused.status, 502);
    assert.deepEqual(await refused.json(), { error: "RPC upstream unavailable." });
  }
});
