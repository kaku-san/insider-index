import assert from "node:assert/strict";
import { address, lamports } from "@solana/kit";
import { Clock } from "litesvm";
import type { ApiV3PoolInfoConcentratedItem } from "@raydium-io/raydium-sdk-v2";
import { PublicKey } from "@solana/web3.js";
import { navJupiterVm, fixture, owner, definition, pk } from "./nav-jupiter-vm.mts";
export { definition, pk };
const bank = JSON.parse(fixture("all-seven-bank.json").toString());
const pools = JSON.parse(fixture("all-seven-pools.json").toString()) as { pools: ApiV3PoolInfoConcentratedItem[] };
const lookups = JSON.parse(fixture("all-seven-lookups.json").toString()) as { keys: string[]; response: { value: { lamports: number; owner: string; data: [string, string] }[] }; poolKeys: { data: { id: string; lookupTableAccount: string }[] } };

/** Captured Raydium pools exercise the NAV keeper's direct-route fallback offline. */
export function allSevenVm() {
  const vm = navJupiterVm();
  for (let n = 0; n < bank.keys.length; n++) {
    const a = bank.response.value[n], id = bank.keys[n];
    if (a && !a.executable && !id.startsWith("Sysvar")) vm.svm.setAccount({ address: address(id), lamports: lamports(BigInt(a.lamports)), data: Buffer.from(a.data[0], "base64"), programAddress: address(a.owner), executable: false, space: BigInt(Buffer.from(a.data[0], "base64").length) });
  }
  for (let n = 0; n < lookups.keys.length; n++) {
    const a = lookups.response.value[n], data = Buffer.from(a.data[0], "base64");
    vm.svm.setAccount({ address: address(lookups.keys[n]), lamports: lamports(BigInt(a.lamports)), data, programAddress: address(a.owner), executable: false, space: BigInt(data.length) });
  }
  const c = Buffer.from(bank.response.value[bank.keys.indexOf("SysvarC1ock11111111111111111111111111111111")].data[0], "base64");
  vm.svm.setClock(new Clock(BigInt(bank.response.context.slot), c.readBigInt64LE(8), c.readBigUInt64LE(16), c.readBigUInt64LE(24), c.readBigInt64LE(32)));
  vm.connection.getMultipleAccountsInfoAndContext = async keys => ({ context: { slot: Number(vm.svm.getClock().slot) }, value: await vm.connection.getMultipleAccountsInfo(keys) });
  const now = () => Number(vm.svm.getClock().unixTimestamp) * 1000;
  async function metadata(pool: string) {
    const p = pools.pools.find(p => p.id === pool); assert(p);
    return { pool: structuredClone(p), observedAt: now(), lookupTable: lookups.poolKeys.data.find(k => k.id === pool)?.lookupTableAccount };
  }
  return { ...vm, owner, keeper: new PublicKey(new Uint8Array(32).fill(17)).toBase58(), now, metadata };
}
