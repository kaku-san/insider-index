/**
 * The SDK's `createVaultTx` serializes a `recent_slot` into `createVaultIx` and derives the two
 * lookup-table accounts from the vault + that slot. The native program CPIs into Solana's Address
 * Lookup Table program, whose CreateLookupTable rejects a slot not in SlotHashes. In particular a
 * current confirmed-bank slot can fail a same-bank pre-sign simulation with InvalidInstructionData.
 *
 * We retain the SDK-created vault/mint and re-target only this documented, coupled tuple on every
 * prepare: `recent_slot`, LUT(vault, recent_slot), LUT(vault, recent_slot - 1). The target is the
 * current finalized slot, which is already behind the confirmed simulation bank but inside the
 * SlotHashes window. This is deliberately applied to the cached draft too: refreshing only its
 * blockhash leaves the old LUT slot stale. No retry calls `createVaultTx` again.
 */
import bs58 from "bs58";
import { PublicKey, VersionedTransaction } from "@solana/web3.js";
import type { Connection } from "@solana/web3.js";
import { VAULTS_V3_PROGRAM_ID } from "@symmetry-hq/sdk/dist/constants.js";
import { getLookupTableAccount } from "@symmetry-hq/sdk/dist/instructions/pda.js";

/** `createVaultIx`'s Anchor discriminator, exported by the SDK's createBasket instruction. */
export const CREATE_VAULT_DISCRIMINATOR = Buffer.from([175, 138, 181, 18, 46, 58, 146, 159]);
/** The SDK puts the u64 `slot` directly after its 8-byte discriminator. */
const SLOT_OFFSET = CREATE_VAULT_DISCRIMINATOR.length;
/** Solana SlotHashes retains 512 slots; leave headroom for RPC/signer latency. */
export const CREATE_SLOT_MAX_AGE = 400;
/** A signed transaction is sent immediately, so it may use more of the real 512-slot window. */
export const CREATE_SLOT_SUBMIT_MAX_AGE = 500;

function instructionData(data: string): Buffer {
  return Buffer.from(bs58.decode(data));
}

function createVaultIxIndex(tx: VersionedTransaction): number {
  for (let index = 0; index < tx.message.compiledInstructions.length; index++) {
    const ix = tx.message.compiledInstructions[index];
    const program = tx.message.staticAccountKeys[ix.programIdIndex];
    if (program?.equals(VAULTS_V3_PROGRAM_ID) && instructionData(ix.data).subarray(0, SLOT_OFFSET).equals(CREATE_VAULT_DISCRIMINATOR)) return index;
  }
  return -1;
}

/** Returns the native create instruction's slot, or null for non-create transactions. */
export function createVaultSlotOf(tx: VersionedTransaction): number | null {
  const index = createVaultIxIndex(tx);
  if (index < 0) return null;
  const data = instructionData(tx.message.compiledInstructions[index].data);
  if (data.length < SLOT_OFFSET + 8) throw new Error("CREATE_SLOT_LAYOUT: createVaultIx has no u64 recent_slot.");
  const slot = Number(data.readBigUInt64LE(SLOT_OFFSET));
  if (!Number.isSafeInteger(slot) || slot < 1) throw new Error("CREATE_SLOT_LAYOUT: createVaultIx recent_slot is not a positive safe integer.");
  return slot;
}

/**
 * Verifies the field the ALT program consumes. This is a local operator error, not a best-effort
 * warning: a stale draft must never be handed to a signer or broadcast.
 */
export function assertCreateVaultSlotFresh(
  tx: VersionedTransaction,
  chainSlot: number,
  maxAge = CREATE_SLOT_MAX_AGE,
): number | null {
  const slot = createVaultSlotOf(tx);
  if (slot === null) return null;
  if (!Number.isSafeInteger(chainSlot) || chainSlot < 1) throw new Error("CREATE_SLOT_UNREADABLE: chain slot is not a positive safe integer.");
  const age = chainSlot - slot;
  if (age < 1 || age > maxAge) {
    const description = age < 1 ? "is not behind" : `is ${age} slots behind`;
    throw new Error(
      `CREATE_SLOT_STALE: createVaultIx recent_slot ${slot} ${description} confirmed slot ${chainSlot}. ` +
      `The native ALT CreateLookupTable CPI accepts only a recent SlotHashes entry; prepare a fresh unsigned transaction and sign it immediately.`,
    );
  }
  return slot;
}

/** Reads the confirmed bank and validates a serialized create transaction without signing or sending. */
export async function assertCreateVaultSlotFreshFromRpc(
  connection: Pick<Connection, "getSlot">,
  tx: VersionedTransaction,
  maxAge = CREATE_SLOT_MAX_AGE,
): Promise<number | null> {
  if (createVaultSlotOf(tx) === null) return null;
  return assertCreateVaultSlotFresh(tx, await connection.getSlot("confirmed"), maxAge);
}

function staticKeyAt(tx: VersionedTransaction, index: number, label: string): PublicKey {
  const key = tx.message.staticAccountKeys[index];
  if (!key) throw new Error(`CREATE_SLOT_LAYOUT: ${label} is not a static account key.`);
  return key;
}

/**
 * Changes the SDK's coupled `recent_slot`/LUT account tuple, after proving that the SDK's original
 * tuple is present. This never touches vault/mint derivation, metadata, fees, legs, or signatures.
 */
export function retargetCreateVaultSlot(tx: VersionedTransaction, recentSlot: number): number | null {
  const oldSlot = createVaultSlotOf(tx);
  if (oldSlot === null) return null;
  if (!Number.isSafeInteger(recentSlot) || recentSlot < 2) throw new Error("CREATE_SLOT_LAYOUT: replacement recent_slot must be a safe integer of at least 2.");
  const index = createVaultIxIndex(tx);
  const ix = tx.message.compiledInstructions[index];
  // SDK createBasket.ts documents this exact account order: creator, vault, mint, metadata,
  // LUT(vault, slot), LUT(vault, slot - 1), then custody/program accounts.
  if (ix.accountKeyIndexes.length < 6) throw new Error("CREATE_SLOT_LAYOUT: createVaultIx lacks its SDK lookup-table accounts.");
  const vault = staticKeyAt(tx, ix.accountKeyIndexes[1], "vault");
  const lookup0Index = ix.accountKeyIndexes[4];
  const lookup1Index = ix.accountKeyIndexes[5];
  const lookup0 = staticKeyAt(tx, lookup0Index, "lookup table 0");
  const lookup1 = staticKeyAt(tx, lookup1Index, "lookup table 1");
  const expectedOld0 = getLookupTableAccount(vault, oldSlot);
  const expectedOld1 = getLookupTableAccount(vault, oldSlot - 1);
  if (!lookup0.equals(expectedOld0) || !lookup1.equals(expectedOld1)) {
    throw new Error("CREATE_SLOT_LAYOUT: createVaultIx lookup-table accounts do not match the SDK vault/recent_slot derivation; refusing to alter the transaction.");
  }
  const data = instructionData(ix.data);
  data.writeBigUInt64LE(BigInt(recentSlot), SLOT_OFFSET);
  ix.data = bs58.encode(data);
  tx.message.staticAccountKeys[lookup0Index] = getLookupTableAccount(vault, recentSlot);
  tx.message.staticAccountKeys[lookup1Index] = getLookupTableAccount(vault, recentSlot - 1);
  return createVaultSlotOf(tx);
}

/**
 * Refresh a cached unsigned create transaction without a second `createVaultTx` call. A finalized
 * slot is valid for the confirmed simulator and gives the ALT CPI the required SlotHashes age;
 * blockhash and slot are refreshed together before returning the bytes to the wallet.
 */
export async function refreshCreateVaultTransaction(
  connection: Pick<Connection, "getLatestBlockhash" | "getSlot">,
  txBase64: string,
): Promise<string> {
  const tx = VersionedTransaction.deserialize(Buffer.from(txBase64, "base64"));
  if (tx.signatures.some(signature => signature.some(byte => byte !== 0))) throw new Error("Cached create draft is unexpectedly signed.");
  if (createVaultSlotOf(tx) !== null) {
    const finalizedSlot = await connection.getSlot("finalized");
    retargetCreateVaultSlot(tx, finalizedSlot);
    // Validate against the bank that will execute pre-sign simulation, not against an inferred delay.
    assertCreateVaultSlotFresh(tx, await connection.getSlot("confirmed"));
  }
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  tx.message.recentBlockhash = blockhash;
  return Buffer.from(tx.serialize()).toString("base64");
}
