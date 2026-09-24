import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { getTransactionDecoder, address, lamports } from "@solana/kit";
import { LiteSVM, FailedTransactionMetadata, Clock, Rent } from "litesvm";
import { AddressLookupTableAccount, PublicKey, TransactionMessage, VersionedTransaction, TransactionInstruction, type Connection } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID, unpackAccount, unpackMint } from "@solana/spl-token";
import { MAINNET_USDC } from "../../src/lib/nav-vault/constants.ts";
import type { PersistedVaultLeg } from "../../src/lib/index-vaults/vault-definition-store.ts";

// These fixtures run in isolated node:test processes; accidental network access must fail.
globalThis.fetch = async () => { throw new Error("OFFLINE NAV VM: network forbidden"); };
const root = new URL("../fixtures/nav-jupiter/", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("MANIFEST.json", root), "utf8")) as Record<string, string>;
export function fixture(name: string) {
  const bytes = gunzipSync(readFileSync(new URL(`${name}.gz`, root)));
  assert.equal(createHash("sha256").update(bytes).digest("hex"), manifest[name], name);
  return bytes;
}
interface Capture { keys: string[]; response: { context: { slot: number }; value: ({ lamports: number; data: [string, string]; owner: string; executable: boolean } | null)[] } }
interface Account { lamports: number; owner: string; data: string; executable: boolean }
export interface JsonInstruction { programId: string; data: string; accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[] }
const bank = JSON.parse(fixture("bank.json").toString()) as {
  owner: string; accounts: Record<string, Account>; vaultLegs: PersistedVaultLeg[];
  programs: Record<string, { owner: string; sha256: string }>;
};
export const exitBuild = JSON.parse(fixture("jup-exit-build.json").toString()).built as {
  swapInstruction: JsonInstruction; addressLookupTableAddresses: string[];
};
export const exitQuote = JSON.parse(fixture("jup-exit-quote.json").toString()).quote as {
  inputMint: string; outputMint: string; inAmount: string; otherAmountThreshold: string;
};
export const pk = (key: string) => new PublicKey(key);
export const owner = bank.owner;
export const definition = { vaultLegs: bank.vaultLegs };
export { MAINNET_USDC };
export const decodeInstruction = (ix: JsonInstruction) => new TransactionInstruction({ programId: pk(ix.programId), data: Buffer.from(ix.data, "base64"), keys: ix.accounts.map(k => ({ ...k, pubkey: pk(k.pubkey) })) });

/** Only captured token/DEX programs and public mint accounts. Inventory funding is synthetic,
 * local to this VM, never evidence of production balances or liquidity. */
export function navJupiterVm() {
  const svm = new LiteSVM().withSigverify(false).withBlockhashCheck(false).withTransactionHistory(0n);
  const knownAddresses = new Set(Object.keys(bank.accounts));
  for (const [id, program] of Object.entries(bank.programs)) {
    const bytes = fixture(`${id}.so`);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), program.sha256);
    svm.addProgramWithLoader(address(id), bytes, address(program.owner));
  }
  for (const [id, a] of Object.entries(bank.accounts)) if (!a.executable && !id.startsWith("Sysvar")) {
    const data = Buffer.from(a.data, "base64");
    svm.setAccount({ address: address(id), lamports: lamports(BigInt(a.lamports)), data, programAddress: address(a.owner), executable: false, space: BigInt(data.length) });
  }
  const c = Buffer.from(bank.accounts.SysvarC1ock11111111111111111111111111111111.data, "base64");
  svm.setClock(new Clock(c.readBigUInt64LE(0), c.readBigInt64LE(8), c.readBigUInt64LE(16), c.readBigUInt64LE(24), c.readBigInt64LE(32)));
  const rent = Buffer.from(bank.accounts.SysvarRent111111111111111111111111111111111.data, "base64");
  svm.setRent(new Rent(rent.readBigUInt64LE(0), rent.readDoubleLE(8), rent[16]));
  svm.airdrop(address(owner), lamports(5_000_000_000n));
  function info(key: PublicKey) {
    const a = svm.getAccount(address(key.toBase58()));
    return a && "data" in a ? { data: Buffer.from(a.data), owner: pk(a.programAddress), lamports: Number(a.lamports), executable: a.executable, rentEpoch: 0 } : null;
  }
  function simulate(tx: VersionedTransaction) {
    assert(tx.signatures.every(s => s.every(b => b === 0)), "unsigned only");
    const bytes = tx.serialize(); assert(bytes.length <= 1232, "Solana packet cap");
    return svm.simulateTransaction(getTransactionDecoder().decode(bytes));
  }
  const methods = {
    getAccountInfo: async (key: PublicKey) => info(key),
    getMultipleAccountsInfo: async (keys: PublicKey[]) => keys.map(info),
    getAddressLookupTable: async (key: PublicKey) => ({ context: { slot: Number(svm.getClock().slot) }, value: info(key) ? new AddressLookupTableAccount({ key, state: AddressLookupTableAccount.deserialize(info(key)!.data) }) : null }),
    getLatestBlockhash: async () => ({ blockhash: svm.latestBlockhash(), lastValidBlockHeight: Number(svm.getClock().slot) + 150 }),
    getSlot: async () => Number(svm.getClock().slot),
    getBlockTime: async () => Number(svm.getClock().unixTimestamp),
    getTokenSupply: async (key: PublicKey) => {
      const account = info(key); assert(account);
      const mint = unpackMint(key, account, account.owner);
      return { context: { slot: Number(svm.getClock().slot) }, value: { amount: mint.supply.toString(), decimals: mint.decimals, uiAmount: null } };
    },
  };
  const connection = new Proxy(methods, { get(target, key) {
    if (!(key in target)) throw new Error(`OFFLINE NAV VM: unsupported RPC ${String(key)}`);
    return target[key as keyof typeof target];
  } }) as unknown as Connection;
  function apply(wire: string) {
    const result = simulate(VersionedTransaction.deserialize(Buffer.from(wire, "base64")));
    assert(!(result instanceof FailedTransactionMetadata), result.meta().logs().join("\n"));
    for (const a of result.postAccounts()) if (!a.executable && !a.address.startsWith("Sysvar")) { svm.setAccount(a); knownAddresses.add(a.address); }
    svm.warpToSlot(svm.getClock().slot + 1n);
    return result;
  }
  function wire(instructions: TransactionInstruction[], payer = owner) {
    return Buffer.from(new VersionedTransaction(new TransactionMessage({ payerKey: pk(payer), recentBlockhash: svm.latestBlockhash(), instructions }).compileToV0Message()).serialize()).toString("base64");
  }
  async function balance(who: string, mint: string, program = TOKEN_PROGRAM_ID) {
    const ata = getAssociatedTokenAddressSync(pk(mint), pk(who), true, program), account = info(ata);
    return account ? unpackAccount(ata, account, program).amount : 0n;
  }
  function loadDex() {
    const capture = JSON.parse(fixture("jup-exit-accounts.json").toString()) as Capture;
    capture.keys.forEach((id, i) => {
      const a = capture.response.value[i], present = svm.getAccount(address(id));
      if (!a || a.executable || id.startsWith("Sysvar") || (present && "data" in present && present.data.length > 0)) return;
      const data = Buffer.from(a.data[0], "base64");
      svm.setAccount({ address: address(id), lamports: lamports(BigInt(a.lamports)), data, programAddress: address(a.owner), executable: false, space: BigInt(data.length) });
    });
    const programs = JSON.parse(fixture("jup-exit-programs.json").toString()).programs as { id: string; sha256: string }[];
    for (const p of programs) {
      const binary = fixture(`${p.id}.so`);
      assert.equal(createHash("sha256").update(binary).digest("hex"), p.sha256);
      svm.addProgramWithLoader(address(p.id), binary, address("BPFLoaderUpgradeab1e11111111111111111111111"));
    }
  }
  return { svm, connection, simulate, apply, wire, balance, loadDex, knownAddresses };
}
export async function withVmTime<T>(vm: ReturnType<typeof navJupiterVm>, run: () => Promise<T>) {
  const original = Date.now;
  Date.now = () => Number(vm.svm.getClock().unixTimestamp) * 1000;
  try { return await run(); } finally { Date.now = original; }
}
