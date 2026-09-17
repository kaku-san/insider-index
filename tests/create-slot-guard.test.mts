import test from "node:test";
import assert from "node:assert/strict";
import Decimal from "decimal.js";
import { Keypair, PublicKey, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { createVaultIx } from "@symmetry-hq/sdk/dist/instructions/management/createBasket.js";
import { getLookupTableAccount } from "@symmetry-hq/sdk/dist/instructions/pda.js";
import { decimalToFraction } from "@symmetry-hq/sdk/dist/layouts/fraction.js";
import {
  assertCreateVaultSlotFresh, createVaultSlotOf, refreshCreateVaultTransaction, retargetCreateVaultSlot,
} from "../src/lib/index-vaults/create-slot-guard.ts";

const creator = Keypair.generate().publicKey;
const vault = Keypair.generate().publicKey;
const mint = Keypair.generate().publicKey;
const blockhash = PublicKey.default.toBase58();

function createTransaction(slot = 1_000): VersionedTransaction {
  const ix = createVaultIx({
    vault,
    mint,
    slot,
    creator,
    host: creator,
    startPrice: decimalToFraction(new Decimal(1)),
    hostFees: {
      hostDepositFeeBps: 25,
      hostWithdrawalFeeBps: 0,
      hostManagementFeeBps: 0,
      hostPerformanceFeeBps: 0,
    },
    metadataParams: { name: "Kaku San Index", symbol: "KAKU", uri: "" },
    network: "mainnet",
  });
  return new VersionedTransaction(new TransactionMessage({ payerKey: creator, recentBlockhash: blockhash, instructions: [ix] }).compileToV0Message());
}

function lookupKeys(tx: VersionedTransaction): [PublicKey, PublicKey] {
  const ix = tx.message.compiledInstructions[0];
  return [tx.message.staticAccountKeys[ix.accountKeyIndexes[4]], tx.message.staticAccountKeys[ix.accountKeyIndexes[5]]];
}

test("the SDK createVaultIx recent_slot and both lookup-table accounts retarget as one validated tuple", () => {
  const tx = createTransaction();
  assert.equal(createVaultSlotOf(tx), 1_000);
  assert.deepEqual(lookupKeys(tx).map(key => key.toBase58()), [
    getLookupTableAccount(vault, 1_000).toBase58(),
    getLookupTableAccount(vault, 999).toBase58(),
  ]);

  assert.equal(retargetCreateVaultSlot(tx, 980), 980);
  assert.equal(createVaultSlotOf(tx), 980);
  assert.deepEqual(lookupKeys(tx).map(key => key.toBase58()), [
    getLookupTableAccount(vault, 980).toBase58(),
    getLookupTableAccount(vault, 979).toBase58(),
  ]);
  assert.doesNotThrow(() => assertCreateVaultSlotFresh(tx, 1_000));
  assert.throws(() => assertCreateVaultSlotFresh(tx, 980), /CREATE_SLOT_STALE/);
  assert.throws(() => assertCreateVaultSlotFresh(tx, 1_500), /CREATE_SLOT_STALE/);
});

test("refusing an unexpected LUT derivation prevents unsafe transaction byte edits", () => {
  const tx = createTransaction();
  const ix = tx.message.compiledInstructions[0];
  tx.message.staticAccountKeys[ix.accountKeyIndexes[4]] = Keypair.generate().publicKey;
  assert.throws(() => retargetCreateVaultSlot(tx, 980), /lookup-table accounts do not match/);
});

test("a cached unsigned create refreshes finalized ALT slot and blockhash without a second SDK build", async () => {
  const first = createTransaction();
  const source = Buffer.from(first.serialize()).toString("base64");
  const calls: string[] = [];
  const connection = {
    getSlot: async (commitment: string) => {
      calls.push(`slot:${commitment}`);
      return commitment === "finalized" ? 2_000 : 2_020;
    },
    getLatestBlockhash: async (commitment: string) => {
      calls.push(`blockhash:${commitment}`);
      return { blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 1 };
    },
  };
  const refreshed = await refreshCreateVaultTransaction(connection as never, source);
  const tx = VersionedTransaction.deserialize(Buffer.from(refreshed, "base64"));
  assert.equal(createVaultSlotOf(tx), 2_000);
  assert.deepEqual(lookupKeys(tx).map(key => key.toBase58()), [
    getLookupTableAccount(vault, 2_000).toBase58(),
    getLookupTableAccount(vault, 1_999).toBase58(),
  ]);
  assert.equal(tx.signatures.every(signature => signature.every(byte => byte === 0)), true);
  assert.deepEqual(calls, ["slot:finalized", "slot:confirmed", "blockhash:confirmed"]);
});
