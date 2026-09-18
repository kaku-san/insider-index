import assert from "node:assert/strict";
import bs58 from "bs58";
import { getTransactionDecoder } from "@solana/kit";
import { FailedTransactionMetadata } from "litesvm";
import { VersionedTransaction, type Keypair, type VersionedTransactionResponse, type TokenBalance } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, unpackAccount, unpackMint } from "@solana/spl-token";
import { allSevenVm } from "./all-seven-vm.mts";

/** RPC-shaped metadata from REAL local program execution. The only signing key is a deterministic
 * synthetic test key with no real funds. Never a finalized mainnet receipt or a network send. */
export async function localCycleReceipt(vm: ReturnType<typeof allSevenVm>, wire: string, signer: Keypair): Promise<VersionedTransactionResponse> {
  const tx = VersionedTransaction.deserialize(Buffer.from(wire, "base64")); tx.sign([signer]);
  const tables = await Promise.all(tx.message.addressTableLookups.map(async l => { const t = await vm.connection.getAddressLookupTable(l.accountKey); assert(t.value); return t.value; }));
  const lookups = tx.message.version === 0 ? tx.message.resolveAddressTableLookups(tables) : { writable: [], readonly: [] };
  const keys = tx.message.getAccountKeys({ accountKeysFromLookups: lookups });
  const allKeys = Array.from({ length: keys.length }, (_, n) => { const p = keys.get(n); assert(p); return p; });
  const pre = await vm.connection.getMultipleAccountsInfo(allKeys);
  const simulated = vm.svm.simulateTransaction(getTransactionDecoder().decode(tx.serialize()));
  assert(!(simulated instanceof FailedTransactionMetadata), simulated instanceof FailedTransactionMetadata ? simulated.meta().logs().join("\n") : "");
  const post = simulated.postAccounts();
  for (const a of post) vm.svm.setAccount(a);
  const after = await vm.connection.getMultipleAccountsInfo(allKeys);
  async function tokens(accounts: typeof pre): Promise<TokenBalance[]> {
    const rows: TokenBalance[] = [];
    for (let n = 0; n < accounts.length; n++) {
      const a = accounts[n]; if (!a || a.data.length < 165 || ![TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].some(p => a.owner.equals(p))) continue;
      let decoded; try { decoded = unpackAccount(allKeys[n], a, a.owner); } catch { continue; } // mints aren't token accounts
      const m = await vm.connection.getAccountInfo(decoded.mint); assert(m);
      const mint = unpackMint(decoded.mint, m, m.owner);
      rows.push({ accountIndex: n, mint: decoded.mint.toBase58(), owner: decoded.owner.toBase58(), programId: a.owner.toBase58(), uiTokenAmount: { amount: decoded.amount.toString(), decimals: mint.decimals, uiAmount: null, uiAmountString: "unused-by-raw-receipt-decoder" } });
    }
    return rows;
  }
  return { slot: Number(vm.svm.getClock().slot), blockTime: Number(vm.svm.getClock().unixTimestamp), version: tx.message.version,
    transaction: { message: tx.message, signatures: tx.signatures.map(s => bs58.encode(s)) },
    meta: { err: null, fee: Number((pre[0]?.lamports ?? 0) - (after[0]?.lamports ?? 0)),
      preBalances: pre.map(a => a?.lamports ?? 0), postBalances: after.map(a => a?.lamports ?? 0), preTokenBalances: await tokens(pre), postTokenBalances: await tokens(after),
      innerInstructions: simulated.meta().innerInstructions().map((instructions, index) => ({ index, instructions: instructions.map(i => ({ programIdIndex: i.instruction().programIdIndex(), accounts: [...i.instruction().accounts()], data: bs58.encode(i.instruction().data()), stackHeight: i.stackHeight() })) })),
      logMessages: simulated.meta().logs(), loadedAddresses: lookups, computeUnitsConsumed: Number(simulated.meta().computeUnitsConsumed()) },
  };
}
