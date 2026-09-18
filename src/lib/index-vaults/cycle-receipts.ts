import { verify } from "node:crypto";
import bs58 from "bs58";
import { PublicKey, type Connection, type VersionedTransactionResponse } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { getRebalanceIntentPda, getVaultFeesPda } from "@symmetry-hq/sdk/dist/instructions/pda.js";
import { address, rawAmount, sha256 } from "./amounts.ts";
import { MAINNET_USDC } from "./native-defaults.ts";
import { SYMMETRY_PROGRAM_ID } from "./symmetry-adapter.ts";
import type { CycleCredit } from "./cycle-accounting.ts";

export interface CycleMintBinding { mint: string; tokenProgram: string; decimals: number; }
export interface CycleReceiptExpectation {
  signature: string; messageHash: string; payer: string; owner: string; vault: string; shareMint: string;
  operationId: string; minSlot: number; mints: readonly CycleMintBinding[];
}
const REDEEM = Buffer.from([83, 49, 112, 2, 105, 193, 106, 126]);
const pk = (s: string) => new PublicKey(address(s));
const ata = (owner: string, m: CycleMintBinding) => getAssociatedTokenAddressSync(pk(m.mint), pk(owner), true, pk(m.tokenProgram)).toBase58();

/** Fetch finality ourselves; no client-supplied "confirmed credit" endpoint or wallet-wide balance
 * delta can authorize a sale. Unknown/pruned metadata keeps the operation pending for recovery. */
export async function readFinalizedCycleReceipt(connection: Connection, expected: CycleReceiptExpectation) {
  const transaction = await connection.getTransaction(expected.signature, { commitment: "finalized", maxSupportedTransactionVersion: 0 });
  if (!transaction) throw new Error("CYCLE_FINALIZED_RECEIPT_UNAVAILABLE");
  return decodeCycleReceipt(transaction, expected);
}
/** Pure decoder. Its caller MUST obtain `transaction` through a finalized RPC read above. */
export function decodeCycleReceipt(transaction: VersionedTransactionResponse, expected: CycleReceiptExpectation) {
  const { meta, slot } = transaction, message = transaction.transaction.message;
  if (!meta || meta.err || !Number.isSafeInteger(slot) || slot < expected.minSlot || transaction.transaction.signatures[0] !== expected.signature || message.header.numRequiredSignatures !== 1 || message.staticAccountKeys[0].toBase58() !== expected.payer || sha256(message.serialize()) !== expected.messageHash) throw new Error("CYCLE_RECEIPT_IDENTITY_OR_FAILURE");
  const signature = bs58.decode(expected.signature);
  const key = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), pk(expected.payer).toBuffer()]);
  if (signature.length !== 64 || !verify(null, message.serialize(), { key, format: "der", type: "spki" }, signature)) throw new Error("CYCLE_RECEIPT_SIGNATURE");
  if (!meta.preTokenBalances || !meta.postTokenBalances || !meta.innerInstructions || !Number.isSafeInteger(meta.fee) || meta.fee < 0) throw new Error("CYCLE_RECEIPT_METADATA_INCOMPLETE");
  const keys = message.getAccountKeys({ accountKeysFromLookups: meta.loadedAddresses });
  const keyAt = (n: number) => { const key = keys.get(n); if (!key) throw new Error("CYCLE_RECEIPT_ACCOUNT_INDEX"); return key.toBase58(); };
  const mints = new Map(expected.mints.map(m => [m.mint, m]));
  if (mints.size !== expected.mints.length || !mints.has(expected.shareMint)) throw new Error("CYCLE_RECEIPT_MINT_BINDINGS");
  for (const m of mints.values()) if (![TOKEN_PROGRAM_ID.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58()].includes(m.tokenProgram) || !Number.isInteger(m.decimals) || m.decimals < 0 || m.decimals > 18) throw new Error("CYCLE_RECEIPT_TOKEN_PROGRAM");
  type Balance = { account: string; mint: string; owner: string; amount: bigint; };
  function balances(rows: NonNullable<NonNullable<VersionedTransactionResponse["meta"]>["preTokenBalances"]>): Map<string, Balance> {
    const result = new Map<string, Balance>();
    for (const row of rows) {
      const binding = mints.get(row.mint), account = keyAt(row.accountIndex);
      if (!binding || !row.owner || binding.tokenProgram !== row.programId || binding.decimals !== row.uiTokenAmount.decimals || result.has(account)) throw new Error("CYCLE_RECEIPT_TOKEN_METADATA");
      result.set(account, { account, mint: row.mint, owner: address(row.owner), amount: rawAmount(row.uiTokenAmount.amount) });
    }
    return result;
  }
  const before = balances(meta.preTokenBalances), after = balances(meta.postTokenBalances);
  for (const [account, b] of before) { const a = after.get(account); if (a && (a.owner !== b.owner || a.mint !== b.mint)) throw new Error("CYCLE_RECEIPT_ACCOUNT_IDENTITY_CHANGED"); }
  function tokenDelta(owner: string, mint: string): bigint {
    const m = mints.get(mint); if (!m) throw new Error("CYCLE_RECEIPT_UNKNOWN_MINT");
    const account = ata(owner, m), b = before.get(account), a = after.get(account);
    if ((b && (b.owner !== owner || b.mint !== mint)) || (a && (a.owner !== owner || a.mint !== mint))) throw new Error("CYCLE_RECEIPT_ATA_OWNER");
    return (a?.amount ?? 0n) - (b?.amount ?? 0n);
  }
  let mintedShares = 0n, burnedShares = 0n;
  for (const group of meta.innerInstructions) {
    const top = message.compiledInstructions[group.index];
    if (!top || keyAt(top.programIdIndex) !== SYMMETRY_PROGRAM_ID) continue;
    for (const inner of group.instructions) {
      const program = keyAt(inner.programIdIndex); if (program !== mints.get(expected.shareMint)!.tokenProgram) continue;
      const data = Buffer.from(bs58.decode(inner.data)), minting = data[0] === 7 || data[0] === 14, burning = data[0] === 8 || data[0] === 15;
      if ((!minting && !burning) || keyAt(inner.accounts[minting ? 0 : 1]) !== expected.shareMint) continue;
      if (data.length !== (data[0] === 14 || data[0] === 15 ? 10 : 9) || (data.length === 10 && data[9] !== mints.get(expected.shareMint)!.decimals)) throw new Error("CYCLE_RECEIPT_SHARE_CPI_SHAPE");
      const tokenAccount = keyAt(inner.accounts[minting ? 1 : 0]), authority = keyAt(inner.accounts[2]);
      const ownerAta = ata(expected.owner, mints.get(expected.shareMint)!), feeAta = ata(getVaultFeesPda(pk(expected.vault)).toBase58(), mints.get(expected.shareMint)!);
      if (minting && (authority !== expected.vault || ![ownerAta, feeAta].includes(tokenAccount))) throw new Error("CYCLE_RECEIPT_MINT_RECIPIENT");
      if (burning && (authority !== expected.owner || tokenAccount !== ownerAta)) throw new Error("CYCLE_RECEIPT_BURN_OWNER");
      if (minting) mintedShares += data.readBigUInt64LE(1); else burnedShares += data.readBigUInt64LE(1);
    }
  }
  const credits: CycleCredit[] = [];
  for (const group of meta.innerInstructions) {
    const top = message.compiledInstructions[group.index];
    if (!top || keyAt(top.programIdIndex) !== SYMMETRY_PROGRAM_ID || !Buffer.from(top.data).equals(REDEEM)) continue;
    const accounts = top.accountKeyIndexes;
    if (keyAt(accounts[0]) !== expected.payer || keyAt(accounts[1]) !== expected.vault || keyAt(accounts[2]) !== getRebalanceIntentPda(pk(expected.vault), pk(expected.owner)).toBase58() || keyAt(accounts[3]) !== expected.owner) throw new Error("CYCLE_RECEIPT_CLAIM_SCOPE");
    const amounts = new Map<string, bigint>();
    for (const inner of group.instructions) {
      const program = keyAt(inner.programIdIndex);
      if (![TOKEN_PROGRAM_ID.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58()].includes(program)) continue;
      const data = bs58.decode(inner.data);
      if (data[0] !== 3 && data[0] !== 12) continue; // initialization and ATA setup do not create sale credits
      if (data.length !== (data[0] === 3 ? 9 : 10)) throw new Error("CYCLE_RECEIPT_TRANSFER_SHAPE");
      const source = keyAt(inner.accounts[0]), destination = keyAt(inner.accounts[data[0] === 3 ? 1 : 2]);
      const sourceMeta = before.get(source), destMeta = after.get(destination);
      if (!sourceMeta || !destMeta || sourceMeta.mint !== destMeta.mint) throw new Error("CYCLE_RECEIPT_TRANSFER_METADATA");
      const m = mints.get(sourceMeta.mint)!;
      if (m.tokenProgram !== program || sourceMeta.owner !== expected.vault || destMeta.owner !== expected.owner || source !== ata(expected.vault, m) || destination !== ata(expected.owner, m) || keyAt(inner.accounts[data[0] === 3 ? 2 : 3]) !== expected.vault || (data[0] === 12 && (keyAt(inner.accounts[1]) !== m.mint || data[9] !== m.decimals))) throw new Error("CYCLE_RECEIPT_FOREIGN_TRANSFER");
      const amount = Buffer.from(data).readBigUInt64LE(1);
      amounts.set(m.mint, (amounts.get(m.mint) ?? 0n) + amount);
    }
    for (const [mint, amount] of amounts) {
      if (amount === 0n) continue;
      credits.push({ mint, tokenProgram: mints.get(mint)!.tokenProgram, receivedRaw: amount.toString(), soldRaw: "0", operationId: expected.operationId, owner: expected.owner, vault: expected.vault, signature: expected.signature, instructionIndex: group.index });
    }
  }
  const credited = new Map<string, bigint>();
  for (const c of credits) credited.set(c.mint, (credited.get(c.mint) ?? 0n) + rawAmount(c.receivedRaw));
  for (const [mint, amount] of credited) if (tokenDelta(expected.owner, mint) !== amount || tokenDelta(expected.vault, mint) !== -amount) throw new Error("CYCLE_RECEIPT_CREDIT_DELTA_MISMATCH");
  if (credits.length) for (const m of mints.values()) if (!credited.has(m.mint) && tokenDelta(expected.owner, m.mint) !== 0n) throw new Error("CYCLE_RECEIPT_UNRELATED_WALLET_CHANGE");
  const shareDelta = tokenDelta(expected.owner, expected.shareMint), feeDelta = tokenDelta(getVaultFeesPda(pk(expected.vault)).toBase58(), expected.shareMint);
  const beforeLamports = meta.preBalances[0], afterLamports = meta.postBalances[0];
  if (!Number.isSafeInteger(beforeLamports) || !Number.isSafeInteger(afterLamports) || beforeLamports < 0 || afterLamports < 0) throw new Error("CYCLE_RECEIPT_LAMPORT_PRECISION");
  return { signature: expected.signature, slot, credits, tokenDelta,
    ownerShareDelta: shareDelta, feeShareDelta: feeDelta, mintedShares, burnedShares, networkFeeLamports: BigInt(meta.fee),
    payerNetDebitLamports: BigInt(Math.max(meta.fee, beforeLamports - afterLamports)),
    /** Actual token movements, not SDK estimates or a wallet balance substituted for native claims. */
    assertConversion(mint: string, exactDebitRaw: string, minimumUsdcRaw: string) {
      if (mint === MAINNET_USDC || credits.length || tokenDelta(expected.owner, mint) !== -rawAmount(exactDebitRaw, true) || tokenDelta(expected.owner, MAINNET_USDC) < rawAmount(minimumUsdcRaw, true)) throw new Error("CYCLE_RECEIPT_CONVERSION_BOUNDS");
      for (const m of mints.values()) if (m.mint !== mint && m.mint !== MAINNET_USDC && tokenDelta(expected.owner, m.mint) !== 0n) throw new Error("CYCLE_RECEIPT_UNRELATED_WALLET_CHANGE");
    },
  };
}
