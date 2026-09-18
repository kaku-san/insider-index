import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { LiteSVM, FailedTransactionMetadata, Clock, Rent } from "litesvm";
import { getTransactionDecoder, getBase58Encoder, address as kitAddress, lamports } from "@solana/kit";
import { AddressLookupTableAccount, PublicKey, VersionedTransaction, type Connection } from "@solana/web3.js";
import { NativeVaultBuilders, GENESIS } from "../../src/lib/index-vaults/symmetry-adapter.ts";
import type { PersistedVaultDefinition } from "../../src/lib/index-vaults/vault-definition-store.ts";

// This fixture module is used only in isolated node:test processes. Even an accidental
// upstream SDK fetch outside the Connection seam must fail before contacting a network.
globalThis.fetch = async () => { throw new Error("OFFLINE COMPOSITION VM: network forbidden"); };

function fixture(name: string): Buffer { return gunzipSync(readFileSync(new URL(`../fixtures/composition/${name}.gz`, import.meta.url))); }
interface Account { lamports: number; owner: string; data: string; executable: boolean }
export const snapshot = JSON.parse(fixture("vm-snapshot.json").toString()) as {
  creator: string; vault: string; shareMint: string; accounts: Record<string, Account | null>;
  programs: Record<string, { owner: string; sha256: string }>;
};
export const definition = JSON.parse(fixture("definition.json").toString()) as PersistedVaultDefinition;
const shareSupply = JSON.parse(readFileSync(new URL("../fixtures/composition/share-supply.json", import.meta.url), "utf8")) as { mint: string; slot: number; amount: string; decimals: number };

/** Real public deployed programs + historical account fixtures. No signing, sending, airdrop,
 * RPC, journal, DB, network fetch or balance top-up. ONLY local unsigned simulation; successful
 * postAccounts are copied to the isolated VM explicitly by apply(), never by the RPC seam. */
export function compositionVm() {
  const svm = new LiteSVM().withSigverify(false).withBlockhashCheck(false).withTransactionHistory(0n);
  const known = new Set(Object.keys(snapshot.accounts));
  for (const [id, program] of Object.entries(snapshot.programs)) {
    const bytes = fixture(`${id}.so`);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), program.sha256);
    svm.addProgramWithLoader(kitAddress(id), bytes, kitAddress(program.owner));
  }
  for (const [id, a] of Object.entries(snapshot.accounts)) if (a && !a.executable && !id.startsWith("Sysvar")) {
    svm.setAccount({ address: kitAddress(id), lamports: lamports(BigInt(a.lamports)), data: Buffer.from(a.data, "base64"), programAddress: kitAddress(a.owner), executable: false, space: BigInt(Buffer.from(a.data, "base64").length) });
  }
  const clock = Buffer.from(snapshot.accounts.SysvarC1ock11111111111111111111111111111111!.data, "base64");
  svm.setClock(new Clock(clock.readBigUInt64LE(0), clock.readBigInt64LE(8), clock.readBigUInt64LE(16), clock.readBigUInt64LE(24), clock.readBigInt64LE(32)));
  const rent = Buffer.from(snapshot.accounts.SysvarRent111111111111111111111111111111111!.data, "base64");
  svm.setRent(new Rent(rent.readBigUInt64LE(0), rent.readDoubleLE(8), rent[16]));
  function info(key: PublicKey) {
    const a = svm.getAccount(kitAddress(key.toBase58()));
    return a && "data" in a ? { data: Buffer.from(a.data), owner: new PublicKey(a.programAddress), lamports: Number(a.lamports), executable: a.executable, rentEpoch: 0 } : null;
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
    getGenesisHash: async () => GENESIS["mainnet-beta"],
    getSlot: async () => Number(svm.getClock().slot),
    getTokenSupply: async (key: PublicKey) => {
      // Configuration does not mint/burn shares. Project the separately captured parsed mint read;
      // do not invent a raw mint account in the VM to cover the original snapshot's missing account.
      assert.equal(key.toBase58(), shareSupply.mint);
      return { context: { slot: shareSupply.slot }, value: { amount: shareSupply.amount, decimals: shareSupply.decimals, uiAmount: null } };
    },
    getMinimumBalanceForRentExemption: async (size: number) => Number(svm.minimumBalanceForRentExemption(BigInt(size))),
    getProgramAccounts: async (owner: PublicKey, config: { filters: ({ dataSize: number } | { memcmp: { offset: number; bytes: string } })[] }) => [...known].flatMap(id => {
      const pubkey = new PublicKey(id), account = info(pubkey);
      if (!account?.owner.equals(owner) || !config.filters.every(f => "dataSize" in f ? account.data.length === f.dataSize : account.data.subarray(f.memcmp.offset, f.memcmp.offset + getBase58Encoder().encode(f.memcmp.bytes).length).equals(Buffer.from(getBase58Encoder().encode(f.memcmp.bytes))))) return [];
      return [{ pubkey, account }];
    }),
    simulateTransaction: async (tx: VersionedTransaction, config: { accounts?: { addresses: string[] } }) => {
      const result = simulate(tx);
      const failed = result instanceof FailedTransactionMetadata;
      const posts = new Map(failed ? [] : result.postAccounts().map(a => [a.address as string, a]));
      return { context: { slot: Number(svm.getClock().slot) }, value: {
        err: failed ? result.err().toString() : null, logs: result.meta().logs(),
        accounts: config.accounts?.addresses.map(id => {
          const a = posts.get(id) ?? svm.getAccount(kitAddress(id));
          return a && "data" in a ? { data: [Buffer.from(a.data).toString("base64"), "base64"], owner: a.programAddress, lamports: Number(a.lamports), executable: a.executable, rentEpoch: 0 } : null;
        }),
      } };
    },
  };
  const connection = new Proxy(methods, { get(target, key) {
    if (!(key in target)) throw new Error(`OFFLINE VM: unsupported RPC ${String(key)}`);
    return target[key as keyof typeof target];
  } }) as unknown as Connection;
  const native = new NativeVaultBuilders(connection, "mainnet-beta");
  function apply(txBase64: string) {
    const result = simulate(VersionedTransaction.deserialize(Buffer.from(txBase64, "base64")));
    assert(!(result instanceof FailedTransactionMetadata), result.meta().logs().join("\n"));
    for (const a of result.postAccounts()) if (!a.executable && !a.address.startsWith("Sysvar")) { svm.setAccount(a); known.add(a.address); }
    svm.warpToSlot(svm.getClock().slot + 1n);
    return result;
  }
  return { svm, native, connection, simulate, apply, knownAddresses: known };
}
