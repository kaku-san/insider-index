import test from "node:test";
import assert from "node:assert/strict";
import { PublicKey } from "@solana/web3.js";
import { DEVNET_TEST_VAULT, devnetUsdcRaw, canSignDevnetDeposit } from "../src/lib/index-vaults/devnet-contract.ts";
import type { DevnetDepositPreview, DevnetDepositRequest } from "../src/lib/index-vaults/devnet-contract.ts";
import { parseDevnetDepositRequest, previewDevnetDeposit, handleDevnetDeposit } from "../src/lib/index-vaults/devnet-deposit.ts";
import { signPreparedDevnetDeposit, requestDevnetDeposit } from "../src/lib/frontend/devnet-deposit.ts";
import type { NativeVaultBuilders } from "../src/lib/index-vaults/symmetry-adapter.ts";
import { POST as prepareRoute } from "../src/app/api/vaults/devnet/prepare/route.ts";
import { POST as previewRoute } from "../src/app/api/vaults/devnet/preview/route.ts";

const owner = "C7ye6UvJ7jirwCmt3fKmt55MvcW9yBVpgqzZzgCWYQyB";
const input: DevnetDepositRequest = { network: "devnet", vaultAccount: DEVNET_TEST_VAULT.vaultAccount, shareMint: DEVNET_TEST_VAULT.shareMint, owner, amountUsdcRaw: "100000" };
const stateHash = "a".repeat(64);
function reader(pending = false): NativeVaultBuilders {
  // Deterministic native-reader fixture tests orchestration, never evidence of a native roundtrip.
  const fees = Object.fromEntries(["hostWithdrawFeeBps", "hostManagementFeeBps", "hostPerformanceFeeBps", "creatorDepositFeeBps", "creatorWithdrawFeeBps", "creatorManagementFeeBps", "creatorPerformanceFeeBps", "managersDepositFeeBps", "managersWithdrawFeeBps", "managersManagementFeeBps", "managersPerformanceFeeBps", "vaultDepositFeeBps", "vaultWithdrawFeeBps"].map(key => [key, 0]));
  return {
    network: "devnet", connection: { getSlot: async () => 123 },
    read: async () => ({ stateHash, mint: { supply: 1234567890123456789n }, vault: {
      settings: { host: new PublicKey(owner), depositsAreAllowed: 1, fees: { ...fees, hostDepositFeeBps: 25 } },
      accumulatedFees: { hostFees: 0n, creatorFees: 0n, managersFees: 0n, symmetryFees: 0n },
      numTokens: 1, composition: [{ mint: new PublicKey(DEVNET_TEST_VAULT.usdcMint), amount: 100000n, weight: 10000, active: 1 }],
    } }),
    sdk: { fetchGlobalConfig: async () => ({ allowInteractions: 1, bountyBondAmount: 1n }) },
    position: async () => ({ shareBalanceRaw: "42", nativeIntent: pending ? owner : null }),
  } as unknown as NativeVaultBuilders;
}
const request = (body: unknown) => new Request("http://localhost/api/vaults/devnet/preview", { method: "POST", body: JSON.stringify(body) });

test("USDC display input is exact, positive and SDK-safe", () => {
  assert.equal(devnetUsdcRaw("0.1"), "100000");
  assert.equal(devnetUsdcRaw("1.000001"), "1000001");
  assert.equal(devnetUsdcRaw("9007199254.740991"), "9007199254740991");
  for (const amount of ["0", "0.000000", "1.0000001", "1e2", "01", "-1", "NaN", " 1", "9007199254.740992"]) assert.throws(() => devnetUsdcRaw(amount));
});

test("only exact existing devnet identity, canonical raw amounts and wallet owners are accepted", () => {
  assert.deepEqual(parseDevnetDepositRequest(input), input);
  for (const patch of [{ network: "mainnet-beta" }, { vaultAccount: owner }, { shareMint: owner }, { rpcUrl: "https://api.mainnet-beta.solana.com" }, { amountUsdcRaw: "1e6" }, { amountUsdcRaw: "0" }, { amountUsdcRaw: "9007199254740992" }, { owner: "privy-stub:owner" }, { expectedStateHash: "fake" }]) assert.throws(() => parseDevnetDepositRequest({ ...input, ...patch }));
});

test("preview reads native supply/holdings without fabricating shares, quotes or authorization", async () => {
  const preview = await previewDevnetDeposit(input, reader());
  assert.equal(preview.identity.vaultAccount, input.vaultAccount);
  assert.equal(preview.shareSupplyRaw, "1234567890123456789");
  assert.equal(preview.shareBalanceRaw, "42");
  assert.equal(preview.holdings[0].amountRaw, "100000");
  assert.equal(preview.hostEntryFeeBps, 25);
  assert.equal(preview.estimatedSharesRaw, null);
  assert.equal(preview.prepared.requires, "wait");
  assert.deepEqual(preview.prepared.transactions, []);
  assert.equal(canSignDevnetDeposit(preview), false);
  assert.ok(preview.prepared.blockers.length >= 3);
  const disconnected = await previewDevnetDeposit({ ...input, owner: null }, reader());
  assert.equal(disconnected.shareBalanceRaw, null);
});

test("pending intent and changed native state require recovery/repreview; mainnet reader rejected", async () => {
  const result = await previewDevnetDeposit({ ...input, expectedStateHash: "b".repeat(64) }, reader(true));
  assert.ok(result.prepared.blockers.some(reason => reason.includes("Existing native intent")));
  assert.ok(result.prepared.blockers.some(reason => reason.includes("state changed")));
  const wrong = reader(); Object.assign(wrong, { network: "mainnet-beta" });
  await assert.rejects(previewDevnetDeposit(input, wrong), /Devnet reader required/);
});

test("HTTP preview is no-store; prepare is 503 with no signing payload; read failure never becomes zero holdings", async () => {
  const preview = await handleDevnetDeposit(request(input), false, reader());
  assert.equal(preview.status, 200); assert.equal(preview.headers.get("Cache-Control"), "no-store");
  const response = await handleDevnetDeposit(request({ ...input, expectedStateHash: stateHash }), true, reader());
  assert.equal(response.status, 503);
  const body = await response.json(); assert.deepEqual(body.prepared.transactions, []);
  const broken = reader(); broken.read = async () => { throw new Error("RPC private details"); };
  const unavailable = await handleDevnetDeposit(request(input), false, broken);
  assert.equal(unavailable.status, 503);
  assert.deepEqual(Object.keys(await unavailable.json()), ["error"]);
  for (const route of [prepareRoute, previewRoute]) {
    assert.equal((await route(request({ ...input, network: "mainnet-beta" }))).status, 400);
  }
  assert.equal((await handleDevnetDeposit(request(input), true, reader())).status, 400);
});

test("frontend respects blocked prepare response and rejects substituted vault or HTTP errors", async t => {
  const preview = await previewDevnetDeposit(input, reader());
  t.mock.method(globalThis, "fetch", async () => Response.json(preview, { status: 503 }));
  assert.equal((await requestDevnetDeposit(input, true)).prepared.requires, "wait");
  t.mock.method(globalThis, "fetch", async () => Response.json({ ...preview, identity: { ...preview.identity, network: "mainnet-beta" } }));
  await assert.rejects(requestDevnetDeposit(input), /identity mismatch/);
  t.mock.method(globalThis, "fetch", async () => Response.json({ error: "Unavailable" }, { status: 503 }));
  await assert.rejects(requestDevnetDeposit(input), /Unavailable/);
});

test("signing never calls wallet for unreadiness, fixture wallets, stale sessions or forged READY response", async () => {
  const preview = await previewDevnetDeposit(input, reader());
  let calls = 0;
  const wallet = { mode: "live" as const, authenticated: true, solanaAddress: owner, signTransaction: async () => { calls++; return "not-a-real-signature"; } };
  await assert.rejects(signPreparedDevnetDeposit(preview, wallet, () => true), /not ready/);
  await assert.rejects(signPreparedDevnetDeposit(preview, { ...wallet, mode: "stub" }, () => true), /same live wallet/);
  await assert.rejects(signPreparedDevnetDeposit(preview, wallet, () => false), /same live wallet/);
  const forged: DevnetDepositPreview = { ...preview, prepared: { ...preview.prepared, requires: "user-signature", blockers: [], transactions: [{
    stepId: "untrusted", messageBase64: "untrusted", messageHash: stateHash, requiredSigners: [owner], allowedProgramIds: [],
    maxDebits: [], expectedRecipients: [], recentBlockhash: owner, lastValidBlockHeight: 999,
    simulation: { ok: true, slot: 123, logsHash: stateHash },
  }] } };
  await assert.rejects(signPreparedDevnetDeposit(forged, wallet, () => true), /not ready/);
  assert.equal(calls, 0);
});
