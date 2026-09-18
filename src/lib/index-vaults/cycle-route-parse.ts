import { PublicKey, type TransactionInstruction, type AddressLookupTableAccount } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { rawAmount, sha256 } from "./amounts.ts";
export const CYCLE_CLMM_PROGRAM = "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK";
export interface CycleRoute {
  pool: string; inputMint: string; outputMint: string; amountInRaw: string; expectedOutRaw: string; minOutRaw: string;
  inputProgram: string; outputProgram: string; quotedAt: number; expiresAt: number; tvlUsd: number;
  instruction: TransactionInstruction; lookupTables: AddressLookupTableAccount[];
}
export function assertCycleRouteInstruction(route: CycleRoute, owner: string): void {
  const ix = route.instruction, inputProgram = new PublicKey(route.inputProgram), outputProgram = new PublicKey(route.outputProgram);
  if (![inputProgram, outputProgram].every(p => p.equals(TOKEN_PROGRAM_ID) || p.equals(TOKEN_2022_PROGRAM_ID)) || ix.programId.toBase58() !== CYCLE_CLMM_PROGRAM || ix.keys.length < 14 || ix.data.length !== 41 || !ix.data.subarray(0, 8).equals(Buffer.from(sha256("global:swap_v2").slice(0, 16), "hex")) || ix.data[40] !== 1 || ix.data.subarray(24, 40).some(b => b !== 0)) throw new Error("CYCLE_ROUTE_INSTRUCTION_SHAPE");
  if (ix.data.readBigUInt64LE(8) !== rawAmount(route.amountInRaw, true) || ix.data.readBigUInt64LE(16) !== rawAmount(route.minOutRaw, true)) throw new Error("CYCLE_ROUTE_INSTRUCTION_AMOUNTS");
  if (ix.keys[0].pubkey.toBase58() !== owner || !ix.keys[0].isSigner || ix.keys.some((k, n) => n !== 0 && k.isSigner) || ix.keys[2].pubkey.toBase58() !== route.pool || ix.keys[11].pubkey.toBase58() !== route.inputMint || ix.keys[12].pubkey.toBase58() !== route.outputMint ||
    !getAssociatedTokenAddressSync(new PublicKey(route.inputMint), new PublicKey(owner), false, inputProgram).equals(ix.keys[3].pubkey) || !getAssociatedTokenAddressSync(new PublicKey(route.outputMint), new PublicKey(owner), false, outputProgram).equals(ix.keys[4].pubkey)) throw new Error("CYCLE_ROUTE_INSTRUCTION_RECIPIENT");
}
