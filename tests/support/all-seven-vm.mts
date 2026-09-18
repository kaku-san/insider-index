import assert from "node:assert/strict";
import fs from "node:fs";
import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { address, lamports } from "@solana/kit";
import { Clock } from "litesvm";
import type { ApiV3PoolInfoConcentratedItem } from "@raydium-io/raydium-sdk-v2";
import { PublicKey, VersionedTransaction, TransactionMessage, type TransactionInstruction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, unpackAccount, createAssociatedTokenAccountIdempotentInstruction } from "@solana/spl-token";
import { getAta, getRebalanceIntentPda } from "@symmetry-hq/sdk/dist/instructions/pda.js";
import { compositionVm, snapshot, definition } from "./composition-vm.mts";
export { definition };
const ROOT = new URL("../fixtures/mag7-cycle/", import.meta.url);
const hashes = JSON.parse(fs.readFileSync(new URL("MANIFEST.json", ROOT), "utf8"));
function bytes(name: string) { const b = gunzipSync(fs.readFileSync(new URL(`${name}.gz`, ROOT))); assert.equal(createHash("sha256").update(b).digest("hex"), hashes[name]); return b; }
export const bank = JSON.parse(bytes("all-seven-bank.json").toString());
export const pools = JSON.parse(bytes("all-seven-pools.json").toString()) as { at: number; pools: ApiV3PoolInfoConcentratedItem[] };
const lookups = JSON.parse(bytes("all-seven-lookups.json").toString()) as { keys: string[]; response: { value: { lamports: number; owner: string; data: [string, string] }[] }; poolKeys: { data: { id: string; lookupTableAccount: string }[] } };
export const pk = (x: string) => new PublicKey(x);
export function allSevenVm() {
  const vm = compositionVm(), tracked = new Set(bank.keys);
  for (let n = 0; n < bank.keys.length; n++) {
    const a = bank.response.value[n], id = bank.keys[n];
    if (a && !a.executable && !id.startsWith("Sysvar")) vm.svm.setAccount({ address: address(id), lamports: lamports(BigInt(a.lamports)), data: Buffer.from(a.data[0], "base64"), programAddress: address(a.owner), executable: false, space: BigInt(Buffer.from(a.data[0], "base64").length) });
  }
  for (let n = 0; n < lookups.keys.length; n++) {
    const a = lookups.response.value[n], d = Buffer.from(a.data[0], "base64");
    vm.svm.setAccount({ address: address(lookups.keys[n]), lamports: lamports(BigInt(a.lamports)), data: d, programAddress: address(a.owner), executable: false, space: BigInt(d.length) });
  }
  const c = Buffer.from(bank.response.value[bank.keys.indexOf("SysvarC1ock11111111111111111111111111111111")].data[0], "base64");
  vm.svm.setClock(new Clock(BigInt(bank.response.context.slot), c.readBigInt64LE(8), c.readBigUInt64LE(16), c.readBigUInt64LE(24), c.readBigInt64LE(32)));
  vm.svm.addProgramWithLoader(address("CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK"), bytes("CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK.so"), address("BPFLoaderUpgradeab1e11111111111111111111111"));
  const owner = snapshot.creator, keeper = new PublicKey(new Uint8Array(32).fill(17)).toBase58(), vault = snapshot.vault, shareMint = snapshot.shareMint;
  for (const id of [owner, keeper]) vm.svm.setAccount({ address: address(id), lamports: lamports(5_000_000_000n), data: new Uint8Array(), programAddress: address("11111111111111111111111111111111"), executable: false, space: 0n });
  vm.connection.getBlockTime = async () => Number(vm.svm.getClock().unixTimestamp);
  vm.connection.getSlot = async () => Number(vm.svm.getClock().slot);
  function wire(instructions: TransactionInstruction[], payer = owner) { return Buffer.from(new VersionedTransaction(new TransactionMessage({ payerKey: pk(payer), recentBlockhash: vm.svm.latestBlockhash(), instructions }).compileToV0Message()).serialize()).toString("base64"); }
  function apply(payload: { batches: { transactions: { tx_b64: string }[] }[] }) { for (const b of payload.batches) for (const tx of b.transactions) vm.apply(tx.tx_b64); }
  async function balance(who: string, mint: string, program = TOKEN_PROGRAM_ID) { const ata = getAta(pk(who), pk(mint), program), a = await vm.connection.getAccountInfo(ata); return a ? unpackAccount(ata, a, program).amount : 0n; }
  function time(timestamp: number) { const c = vm.svm.getClock(); vm.svm.setClock(new Clock(c.slot, c.epochStartTimestamp, c.epoch, c.leaderScheduleEpoch, BigInt(timestamp))); }
  function now() { return Number(vm.svm.getClock().unixTimestamp) * 1000; }
  // Fixtures test math/program behavior, not wall-clock freshness or a reconstructed historical bank.
  async function metadata(pool: string) { const p = pools.pools.find(p => p.id === pool); assert(p); return { pool: structuredClone(p), observedAt: now(), lookupTable: lookups.poolKeys.data.find(k => k.id === pool)?.lookupTableAccount }; }
  function seed(who: string, mint: string, amount: bigint, program = TOKEN_PROGRAM_ID) {
    const ata = getAta(pk(who), pk(mint), program); tracked.add(ata.toBase58());
    vm.apply(wire([createAssociatedTokenAccountIdempotentInstruction(pk(who), ata, pk(who), pk(mint), program)], who));
    const a = vm.svm.getAccount(address(ata.toBase58())); assert(a.exists); const d = Buffer.from(a.data); d.writeBigUInt64LE(amount, 64); vm.svm.setAccount({ ...a, data: d });
  }
  return { ...vm, owner, keeper, vault, shareMint, wire, apply, balance, time, now, metadata, seed, tracked, intent: getRebalanceIntentPda(pk(vault), pk(owner)).toBase58() };
}
