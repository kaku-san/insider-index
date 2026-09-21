import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";

register("./support/ui-loader.mjs", import.meta.url);
const { handleIndexDepositPrepare, parseIndexDepositRequest } = await import("../src/lib/index-vaults/index-deposit.ts");

const owner = "Jh7cFNUT5FrtBwKakApsc3Gg5aTQjsZtYxa4dbrCoB8";
const vault = "AwDFvjEPPwdF1YgXV8asNt6LeEFDduinYneCn6mHDAsh";
const shareMint = "9ihGfswnUZ6MysSR3KgmrZ57FXDVAiAQ6sEHwLuWwzJ4";

function payload() {
  const instruction = SystemProgram.transfer({ fromPubkey: new PublicKey(owner), toPubkey: new PublicKey(vault), lamports: 1 });
  const message = new TransactionMessage({ payerKey: new PublicKey(owner), recentBlockhash: owner, instructions: [instruction] }).compileToV0Message();
  const transaction = new VersionedTransaction(message);
  return {
    batches: [{ transactions: [{
      tx_b64: Buffer.from(transaction.serialize()).toString("base64"), message_version: "0" as const, recent_blockhash: owner,
      last_valid_block_height: 99, payer: owner, lookup_tables: [],
      instructions: [{ program_id: instruction.programId.toBase58(), accounts: instruction.keys.map(account => ({ pubkey: account.pubkey.toBase58(), is_signer: account.isSigner, is_writable: account.isWritable })), data: instruction.data.toString("base64") }],
    }] }],
  };
}

const definition = {
  indexId: "idx-theme-mag7-caucus", network: "mainnet-beta", name: "Mag7 Caucus", symbol: "IIMAG7", status: "CREATABLE",
  depositsEnabled: true, depositReason: null, bookSource: null, provenance: {}, vaultAddress: vault, shareMint,
  vaultLegs: [], keeper: { pubkey: null, automationEnabled: false }, hostEntryFeeBps: 25, hostExitFeeBps: 0,
};
function dependencies(overrides: Record<string, unknown> = {}) {
  return {
    loadDefinition: async () => definition,
    nativeBuilder: () => ({
      network: "mainnet-beta",
      assertNetwork: async () => {},
      connection: {
        getAccountInfo: async () => null,
        getAddressLookupTable: async () => ({ value: null }),
        getBlockHeight: async () => 1,
        simulateTransaction: async () => ({ context: { slot: 1 }, value: { err: null, logs: [] } }),
      },
      sdk: {
        fetchVault: async () => ({ ownAddress: new PublicKey(vault), mint: new PublicKey(shareMint) }),
        buyVaultTx: async () => payload(), lockDepositsTx: async () => payload(),
      },
    }),
    release: { publicFundsEnabled: true },
    ...overrides,
  };
}
function request(body: unknown) {
  return new Request(`http://localhost/api/indexes/${definition.indexId}/deposit/prepare`, { method: "POST", body: JSON.stringify(body) });
}

test("deposit prepare builds the wallet's contribution and lock without a cycle rail", async () => {
  const response = await handleIndexDepositPrepare(request({ owner, amountRaw: "1000000", idempotencyKey: "demo-1" }), definition.indexId, dependencies() as never);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.requires, "user-signature");
  assert.equal(body.network, "mainnet-beta");
  assert.equal(body.transactions.length, 2);
  assert.deepEqual(body.transactions.map((transaction: { stepId: string }) => transaction.stepId), ["deposit-1", "lock-1"]);
  assert.equal(body.transactions[0].maxDebits[0].owner, owner);
  assert.equal(body.transactions[0].maxDebits[0].amountRaw, "1000000");
  assert.equal(body.transactions[1].maxDebits.length, 0);
  assert.doesNotMatch(JSON.stringify(body), /cycle|policy|recovery/i);
});

test("deposit prepare rejects malformed amounts and every closed gate", async () => {
  assert.throws(() => parseIndexDepositRequest({ owner, amountRaw: "1", amountUsdc: "1" }), /either amountRaw/);
  assert.equal(parseIndexDepositRequest({ owner, amountUsdc: "1.25" }).amountRaw, "1250000");
  const closed = await handleIndexDepositPrepare(request({ owner, amountRaw: "1000000" }), definition.indexId, dependencies({ release: { publicFundsEnabled: false } }) as never);
  assert.equal(closed.status, 503);
  assert.deepEqual(await closed.json(), { error: "Investing is not open for signatures." });
  const absent = await handleIndexDepositPrepare(request({ owner, amountRaw: "1000000" }), definition.indexId, dependencies({ loadDefinition: async () => null }) as never);
  assert.equal(absent.status, 503);
  assert.deepEqual(await absent.json(), { error: "Index not found." });
});
