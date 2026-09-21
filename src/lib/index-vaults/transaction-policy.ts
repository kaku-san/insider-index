import { ComputeBudgetProgram, PublicKey, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import type { Connection, TransactionInstruction } from "@solana/web3.js";
import type { UnsignedMessage } from "./adapter-contract.ts";
import { rawAmount, sha256 } from "./amounts.ts";

export interface DecodedEffects {
  debits: { owner: string; mint: string; amountRaw: string }[];
  recipients: { owner: string; mint: string }[];
  minima: { mint: string; amountRaw: string }[];
}
export interface TransactionPolicy {
  payer: string; signers: string[]; programs: string[]; writableAccounts: string[];
  expectedInstructions: TransactionInstruction[];
  /** Installed server-side, independently audited per instruction/program. Unknown decoding must throw. */
  decode: (instruction: TransactionInstruction) => DecodedEffects;
  maxDebits: DecodedEffects["debits"]; recipients: DecodedEffects["recipients"];
  minima: DecodedEffects["minima"]; maxComputeUnits: number; maxMicroLamports: bigint;
}
function instructionIdentity(ix: TransactionInstruction): string {
  return JSON.stringify([ix.programId.toBase58(), ix.keys.map(k => [k.pubkey.toBase58(), k.isSigner, k.isWritable]), ix.data.toString("base64")]);
}
const sameSet = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join() === [...b].sort().join();

/** Decodes the actual wire message (including fetched ALTs), not SDK summary metadata.
 * This is explicit simulation only. There is deliberately no signer, send, or SDK preflight call.
 */
export async function validateAndSimulate(connection: Pick<Connection, "getAddressLookupTable" | "simulateTransaction" | "getBlockHeight">, input: { stepId: string; transactionBase64: string; lastValidBlockHeight: number }, policy: TransactionPolicy): Promise<UnsignedMessage> {
  const tx = VersionedTransaction.deserialize(Buffer.from(input.transactionBase64, "base64"));
  if (tx.signatures.some(s => s.some(b => b !== 0))) throw new Error("Signed payloads not accepted by read-only policy");
  if (!Number.isSafeInteger(input.lastValidBlockHeight) || input.lastValidBlockHeight <= await connection.getBlockHeight("confirmed")) throw new Error("Expired or missing last-valid block height");
  const tables = await Promise.all(tx.message.addressTableLookups.map(async lookup => {
    const result = await connection.getAddressLookupTable(lookup.accountKey, { commitment: "confirmed" });
    if (!result.value || !result.value.isActive()) throw new Error("Unavailable/deactivated lookup table");
    return result.value;
  }));
  const message = TransactionMessage.decompile(tx.message, { addressLookupTableAccounts: tables });
  const signers = tx.message.staticAccountKeys.slice(0, tx.message.header.numRequiredSignatures).map(k => k.toBase58());
  if (message.payerKey.toBase58() !== policy.payer || !sameSet(signers, policy.signers)) throw new Error("Unexpected payer/signer privilege");
  const keys = tx.message.getAccountKeys({ addressLookupTableAccounts: tables });
  for (let i = 0; i < keys.length; i++) if (tx.message.isAccountWritable(i) && !policy.writableAccounts.includes(keys.get(i)!.toBase58())) throw new Error("Unexpected writable account");
  // Compiled messages union account privileges across instructions. Compare expectations after the same compilation.
  const expectedMessage = new TransactionMessage({ payerKey: new PublicKey(policy.payer), recentBlockhash: message.recentBlockhash, instructions: policy.expectedInstructions }).compileToV0Message(tables);
  const expected = TransactionMessage.decompile(expectedMessage, { addressLookupTableAccounts: tables }).instructions;
  if (message.instructions.length !== expected.length || message.instructions.some((ix, i) => instructionIdentity(ix) !== instructionIdentity(expected[i]))) throw new Error("Instruction bytes/accounts differ from reviewed intent");
  const totals = new Map<string, bigint>(), minimums = new Map<string, bigint>();
  const programs = new Set<string>();
  const computeSeen = new Set<number>();
  for (const ix of message.instructions) {
    const program = ix.programId.toBase58(); programs.add(program);
    if (!policy.programs.includes(program)) throw new Error("Unapproved program");
    if (ix.programId.equals(ComputeBudgetProgram.programId)) {
      const discriminator = ix.data[0];
      if (computeSeen.has(discriminator)) throw new Error("Duplicate compute budget instruction");
      computeSeen.add(discriminator);
      if (discriminator === 2 && ix.data.length === 5 && ix.data.readUInt32LE(1) <= policy.maxComputeUnits) continue;
      if (discriminator === 3 && ix.data.length === 9 && ix.data.readBigUInt64LE(1) <= policy.maxMicroLamports) continue;
      throw new Error("Unsupported/excessive compute budget");
    }
    const effects = policy.decode(ix);
    for (const d of effects.debits) { const key = `${d.owner}:${d.mint}`; totals.set(key, (totals.get(key) ?? 0n) + rawAmount(d.amountRaw)); }
    for (const r of effects.recipients) if (!policy.recipients.some(a => a.owner === r.owner && a.mint === r.mint)) throw new Error("Substituted recipient");
    for (const m of effects.minima) minimums.set(m.mint, (minimums.get(m.mint) ?? 0n) + rawAmount(m.amountRaw));
  }
  for (const [key, amount] of totals) {
    const ceiling = policy.maxDebits.find(d => `${d.owner}:${d.mint}` === key);
    if (!ceiling || amount > rawAmount(ceiling.amountRaw)) throw new Error("Debit exceeds authorized amount");
  }
  for (const minimum of policy.minima) if ((minimums.get(minimum.mint) ?? 0n) < rawAmount(minimum.amountRaw)) throw new Error("Native per-transaction minimum not enforced");
  const result = await connection.simulateTransaction(tx, { commitment: "confirmed", sigVerify: false, replaceRecentBlockhash: false, innerInstructions: true });
  if (result.value.err) {
    const logs = JSON.stringify((result.value.logs ?? []).slice(-20).map(log => log.length > 200 ? `...${log.slice(-197)}` : log));
    throw new Error(`RPC simulation failed: ${JSON.stringify(result.value.err)}; logs tail: ${logs}`);
  }
  const bytes = tx.message.serialize();
  return { stepId: input.stepId, messageBase64: Buffer.from(bytes).toString("base64"), messageHash: sha256(bytes), requiredSigners: signers, allowedProgramIds: [...programs], maxDebits: policy.maxDebits, expectedRecipients: policy.recipients, recentBlockhash: message.recentBlockhash, lastValidBlockHeight: input.lastValidBlockHeight, simulation: { ok: true, slot: result.context.slot, logsHash: sha256(JSON.stringify(result.value.logs ?? [])) } };
}

export function unverifiedInstruction(): never { throw new Error("Instruction semantics not verified: route disabled"); }
