import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, createSyncNativeInstruction, NATIVE_MINT, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { createRebalanceIntentIx, initRebalanceIntentIx, resizeRebalanceIntentIx } from "@symmetry-hq/sdk/dist/instructions/automation/rebalanceIntent.js";
import { getAta, getGlobalConfigPda, getRebalanceIntentPda, getRentPayerPda } from "@symmetry-hq/sdk/dist/instructions/pda.js";
import { networkUsdc, SYMMETRY_PROGRAM_ID } from "../src/lib/index-vaults/symmetry-adapter.ts";

register("./support/ui-loader.mjs", import.meta.url);
const { handleIndexDepositPrepare, parseIndexDepositRequest } = await import("../src/lib/index-vaults/index-deposit.ts");

const owner = "Jh7cFNUT5FrtBwKakApsc3Gg5aTQjsZtYxa4dbrCoB8";
const vault = "AwDFvjEPPwdF1YgXV8asNt6LeEFDduinYneCn6mHDAsh";
const shareMint = "9ihGfswnUZ6MysSR3KgmrZ57FXDVAiAQ6sEHwLuWwzJ4";
const DEPOSIT_RAW = "30000";

function transaction(instructions: TransactionInstruction[]) {
  const message = new TransactionMessage({ payerKey: new PublicKey(owner), recentBlockhash: owner, instructions }).compileToV0Message();
  const signed = new VersionedTransaction(message);
  return {
    tx_b64: Buffer.from(signed.serialize()).toString("base64"), message_version: "0" as const, recent_blockhash: owner,
    last_valid_block_height: 99, payer: owner, lookup_tables: [],
    instructions: instructions.map(instruction => ({ program_id: instruction.programId.toBase58(), accounts: instruction.keys.map(account => ({ pubkey: account.pubkey.toBase58(), is_signer: account.isSigner, is_writable: account.isWritable })), data: instruction.data.toString("base64") })),
  };
}

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
  if (kind === "deposit") instruction.data.writeBigUInt64LE(BigInt(DEPOSIT_RAW), 8);
  return { batches: [{ transactions: [transaction([instruction])] }] };
}

function firstDepositPayloadWithAncillaryCreates() {
  const buyer = new PublicKey(owner);
  const vaultKey = new PublicKey(vault);
  const bountyMint = NATIVE_MINT;
  const intent = getRebalanceIntentPda(vaultKey, buyer);
  const setup = [
    createAssociatedTokenAccountIdempotentInstruction(buyer, getAta(buyer, new PublicKey(shareMint), TOKEN_PROGRAM_ID), buyer, new PublicKey(shareMint)),
    createAssociatedTokenAccountIdempotentInstruction(buyer, getAta(buyer, bountyMint, TOKEN_PROGRAM_ID), buyer, bountyMint),
    SystemProgram.transfer({ fromPubkey: buyer, toPubkey: getAta(buyer, bountyMint, TOKEN_PROGRAM_ID), lamports: 1 }),
    createSyncNativeInstruction(getAta(buyer, bountyMint, TOKEN_PROGRAM_ID)),
    createRebalanceIntentIx({ signer: buyer, owner: buyer, vault: vaultKey }),
    resizeRebalanceIntentIx(intent),
    initRebalanceIntentIx({ signer: buyer, owner: buyer, vault: vaultKey, vaultTokenMint: new PublicKey(shareMint), rebalanceIntentRentPayer: getRentPayerPda(), bountyMint, rebalanceType: 0, rebalanceSlippageBps: 100, perTradeRebalanceSlippageBps: 50, executionStartTime: 0, minBountyAmount: 0, maxBountyAmount: 0, vaultRebalanceIntent: undefined }),
  ];
  return { batches: [{ transactions: [transaction(setup)] }, ...payload("deposit").batches] };
}

const definition = {
  indexId: "idx-theme-mag7-caucus", network: "mainnet-beta", name: "Mag7 Caucus", symbol: "IIMAG7", status: "CREATABLE",
  depositsEnabled: true, depositReason: null, bookSource: null, provenance: {}, vaultAddress: vault, shareMint,
  vaultLegs: [], keeper: { pubkey: null, automationEnabled: false }, hostEntryFeeBps: 25, hostExitFeeBps: 0,
};
function dependencies(overrides: Record<string, unknown> = {}, buy = firstDepositPayloadWithAncillaryCreates(), bountyMint = NATIVE_MINT) {
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
        fetchVault: async () => ({ ownAddress: new PublicKey(vault), mint: new PublicKey(shareMint), settings: { bountyMint } }),
        buyVaultTx: async () => buy, lockDepositsTx: async () => payload("lock"),
      },
    }),
    release: { publicFundsEnabled: true },
    ...overrides,
  };
}
function request(body: unknown) {
  return new Request(`http://localhost/api/indexes/${definition.indexId}/deposit/prepare`, { method: "POST", body: JSON.stringify(body) });
}

test("deposit prepare accepts the measured minimum and atomically simulates first-depositor setup, contribution, and lock", async () => {
  const response = await handleIndexDepositPrepare(request({ owner, amountRaw: DEPOSIT_RAW, idempotencyKey: "demo-1" }), definition.indexId, dependencies() as never);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.requires, "user-signature");
  assert.equal(body.network, "mainnet-beta");
  assert.equal(body.transactions.length, 1);
  assert.deepEqual(body.transactions.map((transaction: { stepId: string }) => transaction.stepId), ["deposit-1"]);
  assert.equal(body.transactions[0].maxDebits[0].owner, owner);
  assert.equal(body.transactions[0].maxDebits[0].amountRaw, DEPOSIT_RAW);
  assert.equal(body.transactions[0].expectedRecipients[0].owner, vault);
  const preparedTransaction = VersionedTransaction.deserialize(Buffer.from(body.transactions[0].messageBase64, "base64"));
  assert.ok(preparedTransaction.signatures.every(signature => signature.every(byte => byte === 0)));
  const merged = TransactionMessage.decompile(preparedTransaction.message).instructions;
  assert.equal(merged.filter(instruction => instruction.programId.toBase58() === SYMMETRY_PROGRAM_ID).length, 5);
  assert.doesNotMatch(JSON.stringify(body), /cycle|policy|recovery/i);
});

test("first-depositor SDK setup accepts only the buyer's expected share and WSOL bounty ATAs", async () => {
  const response = await handleIndexDepositPrepare(request({ owner, amountRaw: DEPOSIT_RAW }), definition.indexId, dependencies({}, firstDepositPayloadWithAncillaryCreates(), NATIVE_MINT) as never);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.transactions.length, 1);
  assert.deepEqual(body.transactions[0].allowedProgramIds.sort(), [ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(), SystemProgram.programId.toBase58(), TOKEN_PROGRAM_ID.toBase58(), SYMMETRY_PROGRAM_ID].sort());
});

test("deposit prepare still rejects an unknown ancillary program", async () => {
  const randomProgram = PublicKey.unique();
  const invalid = firstDepositPayloadWithAncillaryCreates();
  invalid.batches[0]!.transactions[0]!.instructions.push({ program_id: randomProgram.toBase58(), accounts: [], data: "" });
  const response = await handleIndexDepositPrepare(request({ owner, amountRaw: DEPOSIT_RAW }), definition.indexId, dependencies({}, invalid) as never);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "Unsupported ancillary instruction." });
});

test("deposit prepare rejects malformed amounts and every closed gate", async () => {
  assert.throws(() => parseIndexDepositRequest({ owner, amountRaw: "1", amountUsdc: "1" }), /either amountRaw/);
  assert.equal(parseIndexDepositRequest({ owner, amountUsdc: "0.03" }).amountRaw, DEPOSIT_RAW);
  assert.throws(() => parseIndexDepositRequest({ owner, amountUsdc: "0.029999" }), /Minimum is \$0.03/);
  const belowMinimum = await handleIndexDepositPrepare(request({ owner, amountRaw: "29999" }), definition.indexId, dependencies() as never);
  assert.equal(belowMinimum.status, 400);
  assert.deepEqual(await belowMinimum.json(), { error: "Minimum is $0.03." });
  const closed = await handleIndexDepositPrepare(request({ owner, amountRaw: DEPOSIT_RAW }), definition.indexId, dependencies({ release: { publicFundsEnabled: false } }) as never);
  assert.equal(closed.status, 503);
  assert.deepEqual(await closed.json(), { error: "Investing is not open for signatures." });
  const absent = await handleIndexDepositPrepare(request({ owner, amountRaw: DEPOSIT_RAW }), definition.indexId, dependencies({ loadDefinition: async () => null }) as never);
  assert.equal(absent.status, 503);
  assert.deepEqual(await absent.json(), { error: "Index not found." });
});
