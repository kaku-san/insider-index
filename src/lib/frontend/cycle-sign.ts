import { PublicKey, VersionedTransaction, type Connection } from "@solana/web3.js";
import { ed25519 } from "@noble/curves/ed25519";
import { sha256 } from "../index-vaults/amounts.ts";
import { validateCycleOwnerTransaction } from "./cycle-wallet.ts";

/** Shared private/public signing boundary. Wallet signs only; the durable server journal
 * must latch these exact bytes before relay. Never use signAndSendTransaction here. */
export async function signValidatedCycleStep(input: Parameters<typeof validateCycleOwnerTransaction>[0], sign: (wire: string, network: "mainnet-beta") => Promise<string>, beforeSign: () => void = () => {}): Promise<string> {
  const validated = await validateCycleOwnerTransaction(input);
  beforeSign();
  const wire = await sign(input.pending.txBase64, "mainnet-beta");
  const tx = VersionedTransaction.deserialize(Buffer.from(wire, "base64"));
  if (tx.message.header.numRequiredSignatures !== 1 || sha256(tx.message.serialize()) !== validated.messageHash || tx.message.staticAccountKeys[0].toBase58() !== input.policy.owner || !ed25519.verify(tx.signatures[0], tx.message.serialize(), new PublicKey(input.policy.owner).toBytes(), { zip215: false })) throw new Error("CYCLE_WALLET_CHANGED_SIGNED_MESSAGE");
  return wire;
}

/** Retained signatures are not forgotten because an API summary says pending=null. Verify
 * finality of the exact message, or a continuous finalized block chain past its validity.
 * This proves only the retained signed wire; it does not replace the journal's full-message
 * expiry proof or the independent history audit before the NEXT financial signature.
 * Signature-only blocks use the existing bounded same-origin RPC contract. Null/skipped
 * slots are harmless ONLY when the next produced block proves parent/hash/height continuity. */
export async function assertCycleWireResolved(connection: Connection, pending: Parameters<typeof validateCycleOwnerTransaction>[0]["pending"], signature: string): Promise<void> {
  if (await connection.getGenesisHash() !== "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d") throw new Error("CYCLE_WALLET_WRONG_NETWORK");
  const tx = await connection.getTransaction(signature, { commitment: "finalized", maxSupportedTransactionVersion: 0 });
  if (tx) {
    if (!tx.meta || tx.slot < pending.minSlot || tx.transaction.signatures[0] !== signature || sha256(tx.transaction.message.serialize()) !== pending.messageHash) throw new Error("CYCLE_CLIENT_RETAINED_RECEIPT_MISMATCH");
    return;
  }
  const validity = await connection.isBlockhashValid(pending.blockhash, { commitment: "finalized" });
  if (validity.value || validity.context.slot < pending.minSlot || await connection.getBlockHeight("finalized") <= pending.lastValidBlockHeight) throw new Error("CYCLE_CLIENT_RETAINED_SIGNATURE_UNRESOLVED");
  const end = Math.min(validity.context.slot, pending.minSlot + 1023);
  let prior: { slot: number; hash: string; height: number } | undefined;
  for (let slot = pending.minSlot; slot <= end; slot++) {
    let block;
    try { block = await connection.getBlockSignatures(slot, "finalized"); }
    catch (error) {
      const skipped = error instanceof Error && (error.message === `Block ${slot} not found` || ("code" in error && error.code === -32007));
      if (!skipped || !prior) throw error;
      continue;
    }
    if (!block) { if (!prior) throw new Error("CYCLE_CLIENT_EXPIRY_ROOT_UNAVAILABLE"); continue; }
    const height = "blockHeight" in block ? block.blockHeight : null;
    if (typeof height !== "number" || !Number.isSafeInteger(height) || (!prior && block.blockhash !== pending.blockhash) || (prior && (block.parentSlot !== prior.slot || block.previousBlockhash !== prior.hash || height !== prior.height + 1))) throw new Error("CYCLE_CLIENT_EXPIRY_HISTORY_GAP");
    if (block.signatures.includes(signature)) throw new Error("CYCLE_CLIENT_RETAINED_RECEIPT_UNAVAILABLE");
    prior = { slot, hash: block.blockhash, height };
    if (height > pending.lastValidBlockHeight) return;
  }
  throw new Error("CYCLE_CLIENT_EXPIRY_HISTORY_LIMIT");
}
