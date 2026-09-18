import { AddressLookupTableAccount, ComputeBudgetProgram, PublicKey, TransactionMessage, VersionedTransaction, type TransactionInstruction } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import BN from "bn.js";
import { flashWithdrawIx, flashDepositIx } from "@symmetry-hq/sdk/dist/instructions/automation/flashSwap.js";
import type { TxPayloadBatchSequence } from "@symmetry-hq/sdk";
import { sha256, rawAmount } from "./amounts.ts";
import { type NativeVaultBuilders, SYMMETRY_PROGRAM_ID } from "./symmetry-adapter.ts";
import { CYCLE_CLMM_PROGRAM, assertCycleRouteInstruction, type CycleRoute } from "./cycle-routes.ts";

export interface CycleWire { txBase64: string; messageHash: string; payer: string; blockhash: string; }
export async function cycleInstructions(native: NativeVaultBuilders, payload: TxPayloadBatchSequence, payer: string) {
  const tables = new Map<string, AddressLookupTableAccount>(), instructions: TransactionInstruction[] = [];
  for (const item of payload.batches.flatMap(b => b.transactions)) {
    const tx = VersionedTransaction.deserialize(Buffer.from(item.tx_b64, "base64"));
    if (item.payer !== payer || tx.message.staticAccountKeys[0]?.toBase58() !== payer || tx.message.header.numRequiredSignatures !== 1 || tx.signatures.some(s => s.some(b => b !== 0))) throw new Error("CYCLE_SIGNER_MISMATCH");
    for (const lookup of tx.message.addressTableLookups) if (!tables.has(lookup.accountKey.toBase58())) {
      const table = await native.connection.getAddressLookupTable(lookup.accountKey);
      if (!table.value || table.value.state.deactivationSlot !== 0xffffffffffffffffn) throw new Error("CYCLE_LOOKUP_UNAVAILABLE");
      tables.set(lookup.accountKey.toBase58(), table.value);
    }
    instructions.push(...TransactionMessage.decompile(tx.message, { addressLookupTableAccounts: [...tables.values()] }).instructions);
  }
  return { instructions, tables: [...tables.values()] };
}
export function encodeCycleWire(input: { instructions: TransactionInstruction[]; tables?: AddressLookupTableAccount[]; payer: string; blockhash: string; computeUnits: number; microLamports: string; maxPriorityFeeLamports: string }): CycleWire {
  if (!Number.isSafeInteger(input.computeUnits) || input.computeUnits < 1 || input.computeUnits > 1_400_000) throw new Error("CYCLE_COMPUTE_LIMIT");
  const price = rawAmount(input.microLamports);
  if ((BigInt(input.computeUnits) * price + 999999n) / 1000000n > rawAmount(input.maxPriorityFeeLamports)) throw new Error("CYCLE_PRIORITY_FEE_CAP");
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: new PublicKey(input.payer), recentBlockhash: input.blockhash, instructions: [
    ComputeBudgetProgram.setComputeUnitLimit({ units: input.computeUnits }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: price }),
    ...input.instructions.filter(i => !i.programId.equals(ComputeBudgetProgram.programId)),
  ] }).compileToV0Message(input.tables));
  let wire: Uint8Array; try { wire = tx.serialize(); } catch { throw new Error("CYCLE_PACKET_TOO_LARGE"); }
  if (wire.length > 1232 || tx.message.header.numRequiredSignatures !== 1 || tx.message.staticAccountKeys[0]?.toBase58() !== input.payer) throw new Error("CYCLE_PACKET_OR_SIGNER_INVALID");
  return { txBase64: Buffer.from(wire).toString("base64"), messageHash: sha256(tx.message.serialize()), payer: input.payer, blockhash: input.blockhash };
}
function sameInstruction(a: TransactionInstruction, b: TransactionInstruction, writablePayer?: string) {
  return a.programId.equals(b.programId) && a.data.equals(b.data) && a.keys.length === b.keys.length && a.keys.every((key, i) => key.pubkey.equals(b.keys[i].pubkey) && (key.isWritable === b.keys[i].isWritable || (key.pubkey.toBase58() === writablePayer && key.isWritable)) && key.isSigner === b.keys[i].isSigner);
}
/** Combine bounded, independent flash pairs so a large basket need not finalize every leg
 * sequentially inside a short auction window. No split fallback for dependent native pairs.
 * ExactOut mode=1 gives the keeper exactly route.amountInRaw; the route min-out covers the
 * native maximum repayment. Thus existing keeper balances never subsidize a fill. */
export async function buildCycleFillWire(input: { native: NativeVaultBuilders; keeper: string; vault: string; intent: string;
  fills: { route: CycleRoute; maxRepaymentRaw: string }[]; computeUnits: number; microLamports: string; maxPriorityFeeLamports: string;
}): Promise<CycleWire> {
  if (!input.fills.length || new Set(input.fills.map(f => f.route.outputMint)).size !== input.fills.length) throw new Error("CYCLE_DUPLICATE_OR_EMPTY_FILL");
  const all: TransactionInstruction[] = [], tables = new Map<string, AddressLookupTableAccount>();
  const vault = await input.native.sdk.fetchVault(input.vault);
  if (vault.ownAddress.toBase58() !== input.vault) throw new Error("CYCLE_FLASH_VAULT");
  for (let n = 0; n < vault.lookupTables.active.length; n++) {
    if (vault.lookupTables.active[n].equals(PublicKey.default)) continue;
    const table = vault.lutPubkeys?.[n];
    if (!table || table.state.deactivationSlot !== 0xffffffffffffffffn) throw new Error("CYCLE_LOOKUP_INACTIVE");
    tables.set(table.key.toBase58(), table);
  }
  for (const fill of input.fills) {
    const route = fill.route; assertCycleRouteInstruction(route, input.keeper);
    if (rawAmount(route.minOutRaw, true) < rawAmount(fill.maxRepaymentRaw, true) || route.expiresAt <= Date.now()) throw new Error("CYCLE_UNBACKED_OR_EXPIRED_FILL");
    for (const amount of [route.amountInRaw, fill.maxRepaymentRaw]) if (rawAmount(amount, true) > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("CYCLE_SDK_AMOUNT_PRECISION");
    const payload = await input.native.sdk.flashSwapTx({ keeper: input.keeper, vault: input.vault, rebalance_intent: input.intent, mint_in: route.outputMint, mint_out: route.inputMint, amount_in: Number(fill.maxRepaymentRaw), amount_out: Number(route.amountInRaw), mode: 1, jup_swap_ix: route.instruction });
    const decoded = await cycleInstructions(input.native, payload, input.keeper);
    const native = decoded.instructions.filter(i => i.programId.toBase58() === SYMMETRY_PROGRAM_ID);
    const expectedParams = { keeper: new PublicKey(input.keeper), vault: new PublicKey(input.vault), rebalanceIntent: new PublicKey(input.intent), mintIn: new PublicKey(route.outputMint), mintOut: new PublicKey(route.inputMint), mintInProgram: new PublicKey(route.outputProgram), mintOutProgram: new PublicKey(route.inputProgram), amountIn: new BN(fill.maxRepaymentRaw), amountOut: new BN(route.amountInRaw), mode: 1 };
    if (native.length !== 2 || !sameInstruction(native[0], flashWithdrawIx(expectedParams)) || !sameInstruction(native[1], flashDepositIx(expectedParams))) throw new Error("CYCLE_FLASH_IDENTITY_OR_BOUNDS");
    let swaps = 0;
    for (const ix of decoded.instructions) {
      if (ix.programId.equals(ComputeBudgetProgram.programId) || ix.programId.toBase58() === SYMMETRY_PROGRAM_ID) continue;
      if (ix.programId.toBase58() === CYCLE_CLMM_PROGRAM) { if (!sameInstruction(ix, route.instruction, input.keeper)) throw new Error("CYCLE_ROUTE_MUTATED"); swaps++; continue; }
      if (!ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID) || !ix.data.equals(Buffer.from([1])) || ix.keys.length !== 6) throw new Error("CYCLE_UNEXPECTED_FLASH_INSTRUCTION");
      const mint = ix.keys[3].pubkey.toBase58(), program = ix.keys[5].pubkey;
      if (![TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].some(p => p.equals(program)) || ![route.inputMint, route.outputMint].includes(mint) || ix.keys[0].pubkey.toBase58() !== input.keeper || ix.keys[2].pubkey.toBase58() !== input.keeper || !getAssociatedTokenAddressSync(new PublicKey(mint), new PublicKey(input.keeper), false, program).equals(ix.keys[1].pubkey)) throw new Error("CYCLE_FLASH_ATA_RECIPIENT");
    }
    if (swaps !== 1) throw new Error("CYCLE_FLASH_ROUTE_COUNT");
    all.push(...decoded.instructions); for (const t of [...decoded.tables, ...route.lookupTables]) tables.set(t.key.toBase58(), t);
  }
  const { blockhash } = await input.native.connection.getLatestBlockhash("confirmed");
  if (input.fills.some(f => f.route.expiresAt <= Date.now())) throw new Error("CYCLE_FILL_EXPIRED_WHILE_BUILDING");
  return encodeCycleWire({ ...input, payer: input.keeper, blockhash, instructions: all, tables: [...tables.values()] });
}
