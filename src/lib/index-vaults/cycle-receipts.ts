import type { Connection } from "@solana/web3.js";
import { decodeCycleReceipt, type CycleReceiptExpectation } from "./cycle-receipt-parse.ts";
export { decodeCycleReceipt, type CycleReceiptExpectation, type CycleMintBinding } from "./cycle-receipt-parse.ts";

/** Fetch finality ourselves; no client-supplied "confirmed credit" endpoint or wallet-wide balance
 * delta can authorize a sale. Unknown/pruned metadata retains the operation for recovery. */
export async function readFinalizedCycleReceipt(connection: Connection, expected: CycleReceiptExpectation) {
  const transaction = await connection.getTransaction(expected.signature, { commitment: "finalized", maxSupportedTransactionVersion: 0 });
  if (!transaction) throw new Error("CYCLE_FINALIZED_RECEIPT_UNAVAILABLE");
  return decodeCycleReceipt(transaction, expected);
}
