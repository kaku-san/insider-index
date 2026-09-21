import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { getAta, getGlobalConfigPda, getRebalanceIntentPda } from "@symmetry-hq/sdk/dist/instructions/pda.js";
import { networkUsdc, SYMMETRY_PROGRAM_ID } from "../src/lib/index-vaults/symmetry-adapter.ts";

register("./support/ui-loader.mjs", import.meta.url);
const { handleIndexDepositPrepare, parseIndexDepositRequest } = await import("../src/lib/index-vaults/index-deposit.ts");

const owner = "Jh7cFNUT5FrtBwKakApsc3Gg5aTQjsZtYxa4dbrCoB8";
const vault = "AwDFvjEPPwdF1YgXV8asNt6LeEFDduinYneCn6mHDAsh";
const shareMint = "9ihGfswnUZ6MysSR3KgmrZ57FXDVAiAQ6sEHwLuWwzJ4";

function payload(kind: "deposit" | "lock") {
  const buyer = new PublicKey(owner);
  const vaultKey = new PublicKey(vault);
  const usdc = new PublicKey(networkUsdc("mainnet-beta"));
  const intent = getRebalanceIntentPda(vaultKey, buyer);
  const instruction = kind === "deposit"
    ? new TransactionInstruction({
        programId: new PublicKey(SYMMETRY_PROGRAM_ID),
        keys: [
          { pubkey: buyer, isSigner: true, isWritable: true }, { pubkey: vaultKey, isSigner: false, isWritable: true }, { pubkey: intent, isSigner: false, isWritable: true },
          { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }, { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false }, { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }, { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          { pubkey: usdc, isSigner: false, isWritable: false }, { pubkey: getAta(buyer, usdc, TOKEN_PROGRAM_ID), isSigner: false, isWritable: true }, { pubkey: getAta(vaultKey, usdc, TOKEN_PROGRAM_ID), isSigner: false, isWritable: true },
        ],
        data: Buffer.concat([Buffer.from([88, 92, 158, 219, 83, 71, 239, 164]), Buffer.alloc(80)]),
      })
    : new TransactionInstruction({
        programId: new PublicKey(SYMMETRY_PROGRAM_ID),
        keys: [{ pubkey: buyer, isSigner: true, isWritable: true }, { pubkey: intent, isSigner: false, isWritable: true }, { pubkey: getGlobalConfigPda(), isSigner: false, isWritable: false }],
        data: Buffer.from([64, 238, 171, 198, 135, 253, 37, 9]),
      });
  if (kind === "deposit") instruction.data.writeBigUInt64LE(1_000_000n, 8);
  const message = new TransactionMessage({ payerKey: buyer, recentBlockhash: owner, instructions: [instruction] }).compileToV0Message();
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
        fetchVault: async () => ({ ownAddress: new PublicKey(vault), mint: new PublicKey(shareMint), settings: { bountyMint: new PublicKey(shareMint) } }),
        buyVaultTx: async () => payload("deposit"), lockDepositsTx: async () => payload("lock"),
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
