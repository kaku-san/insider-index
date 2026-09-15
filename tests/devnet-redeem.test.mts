import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { Connection, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { AccountLayout, MintLayout, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { SymmetryCore } from "@symmetry-hq/sdk";
import type { Vault, GlobalConfig } from "@symmetry-hq/sdk";
import {
  assertRedeemReadRequest, buildRedeemDiagnostic, inspectRedeemEncoding, observeRedeem,
  redeemKeepTokens, redeemPreflight, redeemRawAmount, REDEEM_TEST_VAULT,
} from "../src/lib/index-vaults/devnet-redeem.ts";
import type { RedeemObservation } from "../src/lib/index-vaults/devnet-redeem.ts";

const mints = ["So11111111111111111111111111111111111111112", "USDCoctVLVnvTXBEuP9s8hntucdJokbo17RwHuNXemT"];
const funded: RedeemObservation = {
  observedSlot: 1, walletLamports: 1_000_000_000, shareSupplyRaw: "1000000", shareBalanceRaw: "1000000",
  spendableAtaSharesRaw: "1000000", ownerIntent: null, activeVaultRebalance: false, keepTokens: mints,
};

// Only read-side state/RPC are fixtures. sellVaultTx and compilation execute the pinned real SDK.
function fixtureSdk() {
  const connection = new Connection(REDEEM_TEST_VAULT.rpc, { fetch: async () => { throw new Error("Unexpected network access"); } });
  connection.getAccountInfo = async () => null;
  connection.getMinimumBalanceForRentExemption = async () => 1000000;
  connection.getLatestBlockhash = async () => ({ blockhash: PublicKey.default.toBase58(), lastValidBlockHeight: 10 });
  const sdk = new SymmetryCore({ connection, network: "devnet" });
  const vault = {
    ownAddress: new PublicKey(REDEEM_TEST_VAULT.vault), mint: new PublicKey(REDEEM_TEST_VAULT.mint), numTokens: 2,
    composition: mints.map((mint, i) => ({ mint: new PublicKey(mint), active: i === 0 })),
    settings: { bountyMint: new PublicKey(mints[1]), activeRebalance: { gt: () => false } },
  } as unknown as Vault;
  sdk.fetchVault = async () => vault;
  sdk.fetchGlobalConfig = async () => ({ bountyMint: new PublicKey(mints[1]) }) as GlobalConfig;
  return { sdk, vault };
}

test("raw shares reject zero, fractional, signed, whitespace and rounded amounts", () => {
  for (const amount of ["0", "-1", "1.0", "1e6", " 1", "+1", "01", "9007199254740992"]) assert.throws(() => redeemRawAmount(amount));
  assert.equal(redeemRawAmount("1"), BigInt(1));
  assert.equal(redeemRawAmount("9007199254740991"), BigInt(Number.MAX_SAFE_INTEGER));
});

test("keep_tokens includes inactive slots; truncated/empty/duplicate composition fails closed", () => {
  const { vault } = fixtureSdk();
  assert.deepEqual(redeemKeepTokens(vault), mints);
  for (const bad of [
    { ...vault, numTokens: 0 }, { ...vault, numTokens: 3 },
    { ...vault, composition: [vault.composition[0], vault.composition[0]] },
  ]) assert.throws(() => redeemKeepTokens(bad));
});

test("real sellVaultTx wire encodes raw burn and ALL native keep tokens; altered requests rejected", async () => {
  const { sdk } = fixtureSdk();
  const payload = await buildRedeemDiagnostic(sdk, funded, "42");
  const diagnostic = inspectRedeemEncoding(payload, mints, "42");
  assert.equal(diagnostic.keepAllTokens, true);
  assert.equal(diagnostic.keepTokensMask, "3");
  assert.equal(diagnostic.messageHash.length, 64);
  assert.throws(() => inspectRedeemEncoding(payload, mints, "43"), /encoding/);
  assert.throws(() => inspectRedeemEncoding(payload, [...mints].reverse(), "42"), /encoding/);
  for (const keep_tokens of [[], [mints[0]]]) {
    const partial = await sdk.sellVaultTx({ seller: REDEEM_TEST_VAULT.owner, vault_mint: REDEEM_TEST_VAULT.mint, withdraw_amount: 42, keep_tokens });
    assert.throws(() => inspectRedeemEncoding(partial, mints, "42"), /encoding/);
  }
  // Changing descriptive metadata cannot hide tampering in the actual compiled transaction.
  const changed = structuredClone(payload);
  const tx = VersionedTransaction.deserialize(Buffer.from(changed.batches[0].transactions[0].tx_b64, "base64"));
  tx.signatures[0][0] = 1;
  changed.batches[0].transactions[0].tx_b64 = Buffer.from(tx.serialize()).toString("base64");
  assert.throws(() => inspectRedeemEncoding(changed, mints, "42"), /unsigned/);
});

test("unfunded, non-ATA, supply mismatch, pending intent and active rebalance never build", async () => {
  for (const patch of [
    { shareBalanceRaw: "0", spendableAtaSharesRaw: "0", shareSupplyRaw: "0" },
    { spendableAtaSharesRaw: "0" }, { shareSupplyRaw: "0" },
    { ownerIntent: REDEEM_TEST_VAULT.vault }, { activeVaultRebalance: true },
  ]) {
    let builds = 0;
    const result = await redeemPreflight("1", {
      observe: async () => ({ ...funded, ...patch }),
      build: async () => { builds++; throw new Error("Must not build"); },
    });
    assert.equal(builds, 0);
    assert.equal(result.status, "BLOCKED");
    assert.equal(result.diagnostic, null);
    assert.equal(result.transactionsBroadcast, 0);
    assert.equal(result.redeemCompleted, false);
    assert.ok(result.blockers.length > 1);
    const { sdk } = fixtureSdk();
    await assert.rejects(buildRedeemDiagnostic(sdk, { ...funded, ...patch }, "1"));
  }
});

test("even funded and correctly encoded native redeem stays blocked with no wire payload released", async () => {
  const { sdk } = fixtureSdk();
  const result = await redeemPreflight("1", {
    observe: async () => funded,
    build: (observation, amount) => buildRedeemDiagnostic(sdk, observation, amount),
  });
  assert.deepEqual(result.blockers, ["NATIVE_REDEEM_ROUNDTRIP_UNVERIFIED"]);
  assert.equal(result.diagnostic?.keepTokensMask, "3");
  assert.equal(result.nativeRedeemVerified, false);
  assert.equal(result.usdcExit, false);
  assert.equal(result.transactionsSigned, 0);
  assert.equal(result.transactionsBroadcast, 0);
  assert.equal("batches" in result, false);
});

test("read-only RPC denies broadcasts, airdrops, unknown methods and mixed batches", () => {
  assert.doesNotThrow(() => assertRedeemReadRequest(JSON.stringify({ method: "getGenesisHash" })));
  for (const method of ["sendTransaction", "sendRawTransaction", "requestAirdrop", "simulateTransaction", "getUnknown"]) {
    assert.throws(() => assertRedeemReadRequest(JSON.stringify({ method })), /read-only/);
    assert.throws(() => assertRedeemReadRequest(JSON.stringify([{ method: "getSlot" }, { method }])), /read-only/);
  }
});

test("wrong endpoint/genesis stops before any native vault reads", async () => {
  for (const [endpoint, genesis] of [["https://api.mainnet-beta.solana.com", REDEEM_TEST_VAULT.genesis], [REDEEM_TEST_VAULT.rpc, "wrong"]]) {
    const connection = new Connection(endpoint);
    connection.getGenesisHash = async () => genesis;
    connection.getMultipleAccountsInfo = async () => { throw new Error("Must not read vault"); };
    await assert.rejects(observeRedeem(connection, fixtureSdk().sdk), /genesis\/endpoint mismatch/);
  }
});

test("observer reads real SPL layouts and separates total ownership from spendable ATA shares", async () => {
  const { sdk, vault } = fixtureSdk();
  const owner = new PublicKey(REDEEM_TEST_VAULT.owner), mint = new PublicKey(REDEEM_TEST_VAULT.mint);
  vault.settings.creator = owner; vault.settings.host = owner;
  vault.settings.activeRebalance = { isZero: () => true } as Vault["settings"]["activeRebalance"];
  const connection = new Connection(REDEEM_TEST_VAULT.rpc);
  connection.getGenesisHash = async () => REDEEM_TEST_VAULT.genesis;
  const info = (data: Buffer, program = TOKEN_PROGRAM_ID, executable = false) => ({ data, owner: program, lamports: 1000000, executable, rentEpoch: 0 });
  connection.getMultipleAccountsInfo = async () => [info(Buffer.alloc(0), PublicKey.default, true), info(Buffer.alloc(0), new PublicKey(REDEEM_TEST_VAULT.program))];
  const mintData = Buffer.alloc(MintLayout.span);
  MintLayout.encode({ mintAuthorityOption: 1, mintAuthority: vault.ownAddress, supply: BigInt(100), decimals: 6, isInitialized: true, freezeAuthorityOption: 0, freezeAuthority: PublicKey.default }, mintData);
  connection.getAccountInfo = async key => key.equals(mint) ? info(mintData) : null;
  connection.getBalance = async () => 123;
  let state = 1;
  connection.getTokenAccountsByOwner = async () => ({ context: { slot: 42 }, value: [
    [getAssociatedTokenAddressSync(mint, owner), BigInt(4)], [PublicKey.default, BigInt(6)],
  ].map(([pubkey, amount]) => {
    const data = Buffer.alloc(AccountLayout.span);
    AccountLayout.encode({ mint, owner, amount: amount as bigint, delegateOption: 0, delegate: PublicKey.default, state, isNativeOption: 0, isNative: BigInt(0), delegatedAmount: BigInt(0), closeAuthorityOption: 0, closeAuthority: PublicKey.default }, data);
    return { pubkey: pubkey as PublicKey, account: info(data) };
  }) });
  const result = await observeRedeem(connection, sdk);
  assert.equal(result.shareBalanceRaw, "10");
  assert.equal(result.spendableAtaSharesRaw, "4");
  assert.equal(result.shareSupplyRaw, "100");
  assert.equal(result.observedSlot, 42);
  assert.equal(result.ownerIntent, null);
  state = 2; // Frozen shares remain owned, but cannot be burned from the ATA.
  const frozen = await observeRedeem(connection, sdk);
  assert.equal(frozen.shareBalanceRaw, "10");
  assert.equal(frozen.spendableAtaSharesRaw, "0");
  vault.settings.creator = PublicKey.default;
  await assert.rejects(observeRedeem(connection, sdk), /identity mismatch/);
});

test("CLI rejects broadcast/network/wallet flags without network access", () => {
  for (const args of [["--broadcast"], ["--network", "mainnet"], ["--wallet", "keypair.json"], ["--shares-raw", "0"]]) {
    const result = spawnSync(process.execPath, ["--experimental-strip-types", "scripts/redeem-devnet-vault.mts", ...args], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
  }
});
