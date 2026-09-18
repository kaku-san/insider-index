import { PublicKey, TransactionInstruction, type VersionedMessage, type LoadedAddresses } from "@solana/web3.js";
import { cyclePolicyHash, type CyclePolicy } from "./cycle-policy-parse.ts";
export const CYCLE_MEMO_PROGRAM = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
export const CYCLE_OWNER_ACTIONS = ["create", "contribute", "lock", "withdraw", "claim", "cancel", "cleanup", "convert"] as const;
export type CycleOwnerAction = typeof CYCLE_OWNER_ACTIONS[number];
/** Public anti-replay provenance only. This is NOT a receipt token or ownership wrapper. */
export function cycleMemo(policy: CyclePolicy, action: CycleOwnerAction): TransactionInstruction {
  return new TransactionInstruction({ programId: CYCLE_MEMO_PROGRAM, keys: [{ pubkey: new PublicKey(policy.owner), isSigner: true, isWritable: false }], data: Buffer.from(`INSIDERINDEX_CYCLE_V1:${cyclePolicyHash(policy)}:${action}`) });
}
export function readCycleMemo(message: VersionedMessage, lookups: LoadedAddresses | undefined, policy: CyclePolicy): CycleOwnerAction | null {
  const keys = message.getAccountKeys({ accountKeysFromLookups: lookups });
  const memos = message.compiledInstructions.filter(ix => keys.get(ix.programIdIndex)?.equals(CYCLE_MEMO_PROGRAM));
  const matching = CYCLE_OWNER_ACTIONS.filter(a => memos.some(m => Buffer.from(m.data).equals(cycleMemo(policy, a).data)));
  if (!matching.length) return null;
  if (memos.length !== 1 || matching.length !== 1 || message.header.numRequiredSignatures !== 1 || message.staticAccountKeys[0].toBase58() !== policy.owner || memos[0].accountKeyIndexes.length !== 1 || keys.get(memos[0].accountKeyIndexes[0])?.toBase58() !== policy.owner) throw new Error("CYCLE_MEMO_OWNER_OR_AMBIGUOUS");
  return matching[0];
}
