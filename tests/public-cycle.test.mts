import assert from "node:assert/strict";
import { test } from "node:test";
import { register } from "node:module";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { Keypair, VersionedTransaction } from "@solana/web3.js";
import { cycleTestOwner } from "./support/cycle-policy.mts";
import { publicCycleFixture, ownerSignature, openTestRelease, publicTestOrigin } from "./support/public-cycle.mts";
import { cycleTestKeeper, cycleTestPolicy } from "./support/cycle-policy.mts";
import { cycleKeeperTick } from "../src/lib/index-vaults/cycle-keeper.ts";
import { MAINNET_USDC } from "../src/lib/index-vaults/native-defaults.ts";
import { PUBLIC_MAG7 } from "../src/lib/index-vaults/public-cycle-parse.ts";
import { cycleAccessMessage, validateCycleAccessBinding } from "../src/lib/index-vaults/cycle-access-parse.ts";
import { publicCycleDirectory, publicCycleIndexEnabled } from "../src/lib/index-vaults/public-cycle-release.ts";
import { handlePublicCycleRequest } from "../src/lib/index-vaults/public-cycle-api.ts";
import type { PublicVaultDefinition } from "../src/lib/index-vaults/vault-definition-store.ts";

register(new URL("./support/ui-loader.mjs", import.meta.url), import.meta.url);

test("public route is present, original-Mag7-only, same-origin and closed without exact policy", async () => {
  const { POST } = await import("../src/app/api/indexes/[id]/cycle/route.ts");
  const p = cycleTestPolicy();
  const request = (body: unknown, origin = publicTestOrigin) => new Request(`${publicTestOrigin}/api/indexes/${PUBLIC_MAG7.indexId}/cycle`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body) });
  assert.equal((await POST(request({ action: "discover", wallet: p.owner }), { params: Promise.resolve({ id: "insiderindex-pelosi" }) })).status, 404);
  assert.equal((await handlePublicCycleRequest(request({ action: "discover", wallet: p.owner }), PUBLIC_MAG7.indexId, { env: {} })).status, 404);
  assert.equal((await handlePublicCycleRequest(request({ action: "discover", wallet: p.owner }, "https://other.example"), PUBLIC_MAG7.indexId, { env: {} })).status, 403);
  assert.equal((await handlePublicCycleRequest(request({ action: "discover", wallet: p.owner, policy: p }), PUBLIC_MAG7.indexId, { env: {} })).status, 409);
  assert.equal((await handlePublicCycleRequest(request({ action: "discover", wallet: "x".repeat(9000) }), PUBLIC_MAG7.indexId, { env: {} })).status, 409);
});

test("public discovery discloses binding only; no signature bypass, client budget or keeper authority", async () => {
  const f = await publicCycleFixture();
  try {
    const response = await f.api({ action: "discover", wallet: f.policy.owner });
    assert.equal(response.status, 200); assert.match(response.headers.get("cache-control")!, /no-store/);
    const discovered = await response.json();
    assert.deepEqual(Object.keys(discovered).sort(), ["binding", "challenge"]);
    assert.equal(discovered.binding.owner, f.policy.owner); assert.equal(discovered.policy, undefined);
    const claims = JSON.parse(Buffer.from(discovered.challenge.token.split(".")[0], "base64url").toString());
    for (const field of ["operationId", "policyHash"]) {
      const forged = { ...claims, [field]: "unbound\nSpend funds" };
      const challenge = { ...discovered.challenge, token: `${Buffer.from(JSON.stringify(forged)).toString("base64url")}.unused`, message: cycleAccessMessage(forged) };
      assert.throws(() => validateCycleAccessBinding(challenge, { ...discovered.binding, [field]: forged[field] }, publicTestOrigin, f.policy.owner), /CHALLENGE_SCOPE/, "discovery cannot smuggle arbitrary text into an access prompt");
    }
    assert.equal((await f.api({ action: "challenge", operationId: f.policy.operationId, wallet: f.policy.owner })).status, 409);
    assert.equal((await f.api({ action: "read", operationId: f.policy.operationId })).status, 403);
    assert.equal((await f.api({ action: "discover", wallet: f.policy.keeper })).status, 404);
    const ownerDiscover = await (await f.api({ action: "discover", wallet: f.policy.owner })).json();
    assert.equal(ownerDiscover.binding.operationId, f.policy.operationId);
    assert.equal(ownerDiscover.recovery, undefined);
    const other = Keypair.fromSeed(new Uint8Array(32).fill(32));
    const otherDiscover = await f.api({ action: "discover", wallet: other.publicKey.toBase58() });
    assert.equal(otherDiscover.status, 200);
    const otherBody = await otherDiscover.json();
    assert.equal(otherBody.binding.owner, other.publicKey.toBase58());
    assert.notEqual(otherBody.binding.operationId, f.policy.operationId);
    assert.equal(otherBody.recovery, undefined);
    assert.doesNotMatch(otherBody.challenge.message, /CYCLE_|reconcile|Retain the operation|private native/i);
    const { ed25519 } = await import("@noble/curves/ed25519");
    const bs58 = (await import("bs58")).default;
    const otherAuth = { token: otherBody.challenge.token, signature: bs58.encode(ed25519.sign(new TextEncoder().encode(otherBody.challenge.message), other.secretKey.subarray(0, 32))) };
    const otherRead = await f.api({ operationId: otherBody.binding.operationId, action: "read", auth: otherAuth });
    assert.equal(otherRead.status, 200);
    const hijack = await f.api({ operationId: f.policy.operationId, action: "read", auth: otherAuth });
    assert.notEqual(hijack.status, 200);
    const hijackBody = await hijack.json();
    assert.equal(hijackBody.recovery, undefined);
    assert.doesNotMatch(hijackBody.message ?? "", /CYCLE_|reconcile|Retain the operation/i);
    await f.access(); assert.deepEqual(f.client.reply!.policy, f.policy);
    const before = await f.journal.read();
    for (const injected of [{ policy: f.policy }, { limits: f.policy.limits }, { amountRaw: "1" }, { actor: "keeper" }, { release: openTestRelease() }]) {
      const r = await f.api({ operationId: f.policy.operationId, action: "prepare", ...injected });
      assert.equal(r.status, 409);
    }
    assert.deepEqual(await f.journal.read(), before); assert.equal(f.sends(), 0);
    const original = f.env.STOCKLANA_CYCLE_POLICIES_JSON;
    f.env.STOCKLANA_CYCLE_POLICIES_JSON = JSON.stringify([{ ...f.policy, vault: f.policy.owner }]);
    assert.notEqual((await f.api({ action: "discover", wallet: f.policy.owner })).status, 200);
    f.env.STOCKLANA_CYCLE_POLICIES_JSON = JSON.stringify([f.policy, { ...f.policy, operationId: "77777777-7777-4777-8777-777777777777" }]);
    const ambiguous = await (await f.api({ action: "discover", wallet: f.policy.owner })).json();
    assert.doesNotMatch(ambiguous.error, /CYCLE_|AMBIGUOUS_POLICY/);
    assert.match(ambiguous.code, /AMBIGUOUS_POLICY/);
    f.env.STOCKLANA_CYCLE_POLICIES_JSON = original;
  } finally { await f.close(); }
});

test("public readiness requires all releases, unique active policy and original created identity; no other index becomes live", async () => {
  const f = await publicCycleFixture();
  try {
    const row = { ...f.record, network: "mainnet-beta", kind: "thematic", legs: [], unmapped: [] } as unknown as PublicVaultDefinition;
    assert.equal(publicCycleIndexEnabled(row, f.env, f.release), true);
    for (const gate of ["publicFundsEnabled", "publicInvestSign"] as const) assert.equal(publicCycleIndexEnabled(row, f.env, { ...f.release, [gate]: false }), false);
    assert.equal(publicCycleIndexEnabled(row, f.env, { ...f.release, nativeUsdcExitVerified: false }), true, "unverified USDC exit stays honest and does not hide Mag7");
    for (const change of [{ vaultAddress: null }, { shareMint: null }, { vaultAddress: f.policy.owner }, { network: "devnet" }, { depositsEnabled: false }, { indexId: "insiderindex-pelosi" }]) assert.equal(publicCycleIndexEnabled({ ...row, ...change }, f.env, f.release), false);
    assert.equal(publicCycleIndexEnabled(row, {}, f.release), false);
    for (const policy of [{ ...f.policy, expiresAt: Date.now() }, { ...f.policy, financialExecutionAuthorized: false }, { ...f.policy, limits: { ...f.policy.limits, depositUsdcRaw: "0" } }]) {
      assert.equal(publicCycleIndexEnabled(row, { STOCKLANA_CYCLE_POLICIES_JSON: JSON.stringify([policy]) }, f.release), false);
    }
    assert.equal(publicCycleIndexEnabled(row, { STOCKLANA_CYCLE_POLICIES_JSON: JSON.stringify([f.policy, { ...f.policy, operationId: "77777777-7777-4777-8777-777777777777" }]) }, f.release), false);
    const otherOwner = Keypair.fromSeed(new Uint8Array(32).fill(32)).publicKey.toBase58();
    assert.equal(publicCycleIndexEnabled(row, { STOCKLANA_CYCLE_POLICIES_JSON: JSON.stringify([f.policy, { ...f.policy, owner: otherOwner, operationId: "88888888-8888-4888-8888-888888888888" }]) }, f.release), false);
    assert.equal(publicCycleIndexEnabled(row, { STOCKLANA_CYCLE_POLICIES_JSON: JSON.stringify([f.policy, { ...f.policy, expiresAt: Date.now(), operationId: "99999999-9999-4999-8999-999999999999" }]) }, f.release), true);
    const directory = publicCycleDirectory([row, { ...row, indexId: "insiderindex-pelosi", vaultAddress: null, shareMint: null }, { ...row, indexId: "idx-theme-other-real-vault" }], f.env, f.release);
    assert.deepEqual(directory.indexes.map(r => r.publicFundsEnabled), [true, false, false]);
    assert.equal(directory.indexes[1].depositsEnabled, row.depositsEnabled, "publication gate does not rewrite the persisted per-vault gate");
  } finally { await f.close(); }
});

test("public discovery restarts an empty Mag7 journal with a new amount", async () => {
  const f = await publicCycleFixture();
  try {
    await f.access();
    await f.journal.update(() => {});
    const prior = f.client.discovery!.binding.policyHash;
    const response = await f.api({ action: "discover", wallet: f.policy.owner, amountRaw: "200000000" });
    assert.equal(response.status, 200);
    const restarted = await response.json();
    assert.notEqual(restarted.binding.policyHash, prior);
    assert.equal(restarted.binding.owner, f.policy.owner);
    assert.equal((await f.db.rpc("read_insiderindex_cycle", { p_operation_id: f.policy.operationId }) as { state: { approvedDepositUsdcRaw: string } }).state.approvedDepositUsdcRaw, "200000000");
  } finally { await f.close(); }
});

test("public API refuses real sub-share bootstrap amount before returning a wire", async () => {
  const f = await publicCycleFixture("500000");
  try {
    await f.access();
    await assert.rejects(f.client.prepare(), /This amount is too small to buy shares\. Try a larger amount\./);
    assert.equal((await f.journal.read()).pending, null); assert.equal(f.sends(), 0);
  } finally { await f.close(); }
});

test("public shutdown/ambiguous HTTP/wallet switch retain exact signed bytes and never replace or duplicate a send", async () => {
  const f = await publicCycleFixture();
  try {
    f.vm.seed(f.policy.owner, MAINNET_USDC, 100_000_000n);
    for (let n = 0; n < 2; n++) { await cycleKeeperTick(f.runner, { execute: true, signer: cycleTestKeeper }); await f.runner.reconcile(); }
    await f.access(); await f.client.prepare();
    const before = f.sends();
    f.release.publicFundsEnabled = false;
    await assert.rejects(f.client.signStep(ownerSignature), /Invest isn't set up for this index yet\./);
    assert.equal(f.sends(), before);
    const retained = (await f.journal.read()).pending!.signedTransaction;
    assert(retained, "release shutdown does not forget a received owner signature");
    await assert.rejects(f.client.signStep(ownerSignature), /RETRY_EXACT_BYTES_ONLY/);
    f.release.publicFundsEnabled = true;
    await f.client.retry(); assert.equal(f.sends(), before + 1); await f.client.reconcile();
    await f.client.prepare();
    const transport = f.client.options.fetch!;
    let drop = true;
    f.client.options.fetch = async (url, init) => {
      const response = await transport(url, init);
      if (drop && JSON.parse(String(init?.body)).action === "submit") { drop = false; throw new Error("SYNTHETIC_HTTP_REPLY_LOST"); }
      return response;
    };
    await assert.rejects(f.client.signStep(ownerSignature), /HTTP_REPLY_LOST/);
    const afterLost = f.sends();
    await assert.rejects(f.client.signStep(ownerSignature), /RETRY_EXACT_BYTES_ONLY/);
    await f.client.retry(); assert.equal(f.sends(), afterLost); await f.client.reconcile();
    await f.client.prepare();
    let current = true; f.client.options.isCurrent = () => current;
    await assert.rejects(f.client.signStep(async wire => { const signed = await ownerSignature(wire); current = false; return signed; }), /WALLET_CHANGED/);
    assert.equal(f.client.hasRetainedSignature, true); assert.equal(f.sends(), afterLost);
    assert.equal((await f.journal.read()).pending!.signedTransaction, null);
    current = true;
    await f.client.retry(); assert.equal(f.sends(), afterLost + 1);
    await f.client.reconcile();
  } finally { await f.close(); }
});

test("non-template depositor chooses amount → authenticated API → SQL/native bank → shares → USDC-only exit", async () => {
  const f = await publicCycleFixture("100000000", { templateAmountRaw: "200000000", templateOwner: Keypair.fromSeed(new Uint8Array(32).fill(32)).publicKey.toBase58() });
  try {
    f.vm.seed(f.policy.owner, MAINNET_USDC, 100_000_123n);
    for (const l of f.record.vaultLegs) f.vm.seed(f.policy.owner, l.mint, 123n, TOKEN_2022_PROGRAM_ID);
    await f.access();
    f.release.publicFundsEnabled = false;
    const before = await f.journal.read();
    await assert.rejects(f.client.prepare(), /Invest isn't set up for this index yet\./);
    assert.deepEqual(await f.journal.read(), before, "closed release never acquires a prepare lease/draft");
    assert.equal(f.sends(), 0); f.release.publicFundsEnabled = true;
    async function keeper(expected: string) {
      assert.equal((await f.runner.prepare("keeper")).action, expected);
      await cycleKeeperTick(f.runner, { execute: true, signer: cycleTestKeeper });
      await f.runner.reconcile();
    }
    let signatures = 0;
    const sign = async (wire: string) => { signatures++; return ownerSignature(wire); };
    async function owner(expected: string, request: "next" | "withdraw" = "next") {
      await f.access();
      const prepared = await f.client.prepare(request);
      assert.equal(prepared.preparation?.action, expected, prepared.preparation?.reason);
      assert(prepared.state.pending);
      if (expected === "create") {
        const count = f.sends();
        await assert.rejects(f.client.signStep(async wire => {
          const tx = VersionedTransaction.deserialize(Buffer.from(wire, "base64"));
          tx.message.recentBlockhash = cycleTestKeeper.publicKey.toBase58(); tx.sign([cycleTestOwner]);
          return Buffer.from(tx.serialize()).toString("base64");
        }), /CYCLE_WALLET_CHANGED_SIGNED_MESSAGE/);
        assert.equal(f.sends(), count, "a wallet-returned changed message never reaches relay");
        assert.equal((await f.journal.read()).pending!.signedTransaction, null);
      }
      if (expected === "contribute") {
        const count = signatures;
        f.client.reply!.state.pending!.exactInputRaw = "100000001";
        await assert.rejects(f.client.signStep(sign), /CYCLE_WALLET_CONTRIBUTION/);
        assert.equal(signatures, count, "independent validation rejects a forged server debit before opening wallet");
        await f.client.read();
      }
      const submitted = await f.client.signStep(sign);
      assert(submitted.submission?.signature);
      const count = f.sends();
      await f.client.retry(); assert.equal(f.sends(), count, "replay of retained bytes never duplicates funding/burn");
      const reconciled = await f.client.reconcile();
      assert.equal(reconciled.state.pending, null); assert.equal(reconciled.state.recoveryRequired, null);
    }
    await keeper("setup-keeper"); await keeper("setup-keeper");
    f.vm.seed(f.policy.keeper, MAINNET_USDC, 5_000_000n);
    for (const l of f.record.vaultLegs) f.vm.seed(f.policy.keeper, l.mint, 321n, TOKEN_2022_PROGRAM_ID);
    await owner("create");
    const resumed = await (await f.api({ action: "discover", wallet: f.policy.owner })).json();
    assert.equal(resumed.binding.policyHash, f.client.discovery!.binding.policyHash, "reload resumes selected amount, not the configured $200");
    await owner("contribute");
    assert.equal((await f.journal.read()).contributedUsdcRaw, "100000000", "only the user-selected $100 was deposited");
    await owner("lock");
    let intent = (await f.vm.native.sdk.fetchRebalanceIntent(f.vm.intent)).chain_data;
    f.vm.time(Number(intent.executionStartTime.toString()));
    for (let n = 0; n < 10; n++) { if ((await f.runner.preview("keeper")).action !== "prices") break; await keeper("prices"); }
    intent = (await f.vm.native.sdk.fetchRebalanceIntent(f.vm.intent)).chain_data;
    for (const [n, offset] of [[0, 57], [0, 71], [1, 34], [2, 17]]) { f.vm.time(Number(intent.auctions[n].startTime.toString()) + offset); await keeper("fill"); }
    f.vm.time(Number(intent.auctions[2].endTime.toString()) + 1);
    await keeper("mint"); await keeper("cleanup");
    assert.equal((await f.journal.read()).phase, "holding");
    // New-deposit shutdown does not strand the already approved owner's exit/recovery.
    f.release.publicFundsEnabled = false; f.record.depositsEnabled = false; f.record.keeper.automationEnabled = false;
    await owner("withdraw", "withdraw");
    for (let n = 0; n < 10; n++) { if ((await f.runner.preview("owner")).action !== "claim") break; await owner("claim"); }
    await owner("cleanup");
    for (let n = 0; n < 7; n++) await owner("convert");
    assert.equal((await f.client.prepare()).preparation?.action, "complete");
    const state = await f.journal.read(); assert.equal(state.phase, "complete");
    assert.equal(state.mintedSharesRaw, state.burnedSharesRaw); assert.equal(state.nativeClaimsClear, true);
    assert(BigInt(state.recoveredUsdcRaw) >= BigInt(f.policy.limits.minExitUsdcRaw));
    assert.equal(await f.vm.balance(f.policy.owner, MAINNET_USDC), BigInt(state.recoveredUsdcRaw) + 123n);
    assert.equal(await f.vm.balance(f.policy.keeper, MAINNET_USDC), 5_000_000n);
    for (const l of f.record.vaultLegs) { assert.equal(await f.vm.balance(f.policy.owner, l.mint, TOKEN_2022_PROGRAM_ID), 123n); assert(await f.vm.balance(f.policy.keeper, l.mint, TOKEN_2022_PROGRAM_ID) >= 321n); }
    console.log("LOCAL_PUBLIC_CYCLE_NOT_LIVE", { mintedSharesRaw: state.mintedSharesRaw, recoveredUsdcRaw: state.recoveredUsdcRaw, ownerSignatures: signatures });
  } finally { await f.close(); }
});
