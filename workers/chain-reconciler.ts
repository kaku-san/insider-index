import type { Connection } from "@solana/web3.js";
import type { ObservedOperation } from "../src/lib/index-vaults/adapter-contract.ts";
import type { OperationStore } from "../src/lib/index-vaults/operations.ts";
import { sha256 } from "../src/lib/index-vaults/amounts.ts";

/** No client-supplied final state. A versioned native decoder must independently verify accounts,
 * inner-instruction paths, exact deltas, native fee buckets and remaining claims. Until fixtures
 * exist, callers install no decoder and this fails closed rather than trusting HTTP success.
 */
export async function reconcileFinalized(connection: Pick<Connection, "getTransaction">, store: OperationStore, id: string, signature: string,
  decoder?: (tx: NonNullable<Awaited<ReturnType<Connection["getTransaction"]>>>, prior: ObservedOperation) => Promise<ObservedOperation>) {
  const operation = await store.get(id);
  const attempt = operation.attempts.find(a => a.signature === signature);
  if (!attempt) throw new Error("Unbound signature");
  const tx = await connection.getTransaction(signature, { commitment: "finalized", maxSupportedTransactionVersion: 0 });
  if (!tx || !tx.meta || tx.meta.err) throw new Error("Finalized successful receipt required");
  if (sha256(tx.transaction.message.serialize()) !== attempt.messageHash) throw new Error("Submitted message does not match finalized transaction");
  if (!decoder) throw new Error("Native receipt decoder not verified; preserve pending operation");
  const observed = await decoder(tx, operation.observed);
  return store.applyFinalized(id, observed, signature, tx.slot);
}
