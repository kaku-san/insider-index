import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { register } from "node:module";
import BN from "bn.js";
import { PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { createSyncNativeInstruction, NATIVE_MINT, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { createRebalanceIntentIx, initRebalanceIntentIx, resizeRebalanceIntentIx } from "@symmetry-hq/sdk/dist/instructions/automation/rebalanceIntent.js";
import { getAta, getRebalanceIntentPda, getRentPayerPda } from "@symmetry-hq/sdk/dist/instructions/pda.js";

register("./support/ui-loader.mjs", import.meta.url);
const { handleIndexWithdrawalPrepare, parseIndexWithdrawalRequest } = await import("../src/lib/index-vaults/index-withdraw.ts");

const owner = "8RZ4GrQDsctRGrW4tDZcYZRqFAW23eWkrVcJQ1DH7GyX";
const vault = "AwDFvjEPPwdF1YgXV8asNt6LeEFDduinYneCn6mHDAsh";
const shareMint = "9ihGfswnUZ6MysSR3KgmrZ57FXDVAiAQ6sEHwLuWwzJ4";
const stockMint = "So11111111111111111111111111111111111111112";

function auctionPayload(sharesRaw = "3") {
  const seller = new PublicKey(owner), vaultKey = new PublicKey(vault), mint = new PublicKey(shareMint);
  const intent = getRebalanceIntentPda(vaultKey, seller), bountyAta = getAta(seller, NATIVE_MINT, TOKEN_PROGRAM_ID);
  const instructions = [
    SystemProgram.transfer({ fromPubkey: seller, toPubkey: bountyAta, lamports: 1 }),
    createSyncNativeInstruction(bountyAta),
    createRebalanceIntentIx({ signer: seller, owner: seller, vault: vaultKey }),
    resizeRebalanceIntentIx(intent),
    initRebalanceIntentIx({
      signer: seller, owner: seller, vault: vaultKey, vaultTokenMint: mint, rebalanceIntentRentPayer: getRentPayerPda(), bountyMint: NATIVE_MINT,
      rebalanceType: 1, rebalanceSlippageBps: 100, perTradeRebalanceSlippageBps: 50, executionStartTime: 0, minBountyAmount: 0, maxBountyAmount: 0,
      withdrawParamsBurnAmount: Number(sharesRaw), withdrawParamsTokenMintsHash: Array.from(createHash("sha256").update(Buffer.alloc(32)).update(new PublicKey(stockMint).toBuffer()).digest()), withdrawParamsKeepTokensBitmask: new BN(0), withdrawParamsKeepAllTokens: 0,
      vaultRebalanceIntent: undefined,
    }),
  ];
  const transaction = new VersionedTransaction(new TransactionMessage({ payerKey: seller, recentBlockhash: owner, instructions }).compileToV0Message());
  return { batches: [{ transactions: [{ tx_b64: Buffer.from(transaction.serialize()).toString("base64"), recent_blockhash: owner, last_valid_block_height: 99, payer: owner, lookup_tables: [] }] }] };
}
const definition = {
  indexId: "idx-theme-mag7-caucus", network: "mainnet-beta", name: "Mag7 Caucus", symbol: "IIMAG7", status: "CREATABLE",
  depositsEnabled: true, depositReason: null, bookSource: null, provenance: {}, vaultAddress: vault, shareMint, vaultLegs: [],
  keeper: { pubkey: "keeper", automationEnabled: true }, hostEntryFeeBps: 25, hostExitFeeBps: 0,
};
function dependencies(payload = auctionPayload()) {
  return {
    loadDefinition: async () => definition,
    nativeBuilder: () => ({
      network: "mainnet-beta", assertNetwork: async () => {},
      connection: {
        getAccountInfo: async () => null,
        getAddressLookupTable: async () => ({ value: null }),
        getBlockHeight: async () => 1,
        simulateTransaction: async () => ({ context: { slot: 42 }, value: { err: null, logs: ["auction simulation"] } }),
      },
      sdk: {
        fetchVault: async () => ({ ownAddress: new PublicKey(vault), mint: new PublicKey(shareMint), numTokens: 1, composition: [{ mint: new PublicKey(stockMint) }], settings: { bountyMint: NATIVE_MINT } }),
        sellVaultTx: async () => payload,
      },
    }),
    release: { publicFundsEnabled: true },
  };
}
function request(body: unknown) {
  return new Request(`http://localhost/api/indexes/${definition.indexId}/withdraw/prepare`, { method: "POST", body: JSON.stringify(body) });
}

test("withdraw prepare returns one simulated user-signed empty-keep auction for USDC settlement", async () => {
  const response = await handleIndexWithdrawalPrepare(request({ owner, shareAmountRaw: "3", requestedExitMode: "verified-native-usdc", idempotencyKey: "exit-3" }), definition.indexId, dependencies() as never);
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.network, "mainnet-beta");
  assert.equal(body.requires, "user-signature");
  assert.equal(body.transactions.length, 1);
  assert.equal(body.transactions[0].stepId, "cash-out-auction");
  assert.deepEqual(body.transactions[0].maxDebits, [{ owner, mint: shareMint, amountRaw: "3" }]);
  assert.deepEqual(body.transactions[0].expectedRecipients, [{ owner, mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" }]);
  assert.equal(body.transactions[0].simulation.ok, true);
  assert.match(body.constraints.map((row: { value: string }) => row.value).join(" "), /1 approval now/);
  const prepared = VersionedTransaction.deserialize(Buffer.from(body.transactions[0].messageBase64, "base64"));
  const instructions = TransactionMessage.decompile(prepared.message).instructions;
  const init = instructions[4]!;
  assert.equal(init.data[40], 1, "withdraw intent");
  assert.equal(init.data.readBigUInt64LE(69), 3n, "exact share burn");
  assert.equal(init.data.readBigUInt64LE(109), 0n, "empty keep mask routes through the auction");
  assert.equal(init.data[125], 0, "keep-all is disabled");
});

test("withdraw request refuses in-kind mode, malformed shares, and other vaults", async () => {
  assert.throws(() => parseIndexWithdrawalRequest({ owner, shareAmountRaw: "3", requestedExitMode: "in-kind" }), /USDC cash out/);
  assert.throws(() => parseIndexWithdrawalRequest({ owner, shareAmountRaw: "0", requestedExitMode: "verified-native-usdc" }), /u64 range/);
  const absent = await handleIndexWithdrawalPrepare(request({ owner, shareAmountRaw: "3", requestedExitMode: "verified-native-usdc" }), "idx-theme-other", dependencies() as never);
  assert.equal(absent.status, 503);
  assert.deepEqual(await absent.json(), { error: "Cash out is not available for this vault." });
});
