import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { address, lamports } from "@solana/kit";
import { Clock } from "litesvm";
import { PublicKey, TransactionMessage, VersionedTransaction, TransactionInstruction } from "@solana/web3.js";
import type { TxPayloadBatchSequence } from "@symmetry-hq/sdk";
import { getAta, getRebalanceIntentPda } from "@symmetry-hq/sdk/dist/instructions/pda.js";
import { createAssociatedTokenAccountIdempotentInstruction, TOKEN_PROGRAM_ID, unpackAccount, unpackMint } from "@solana/spl-token";
import { compositionVm, snapshot, definition } from "./composition-vm.mts";
import { MAINNET_USDC, NATIVE_DEFAULT_BINDINGS } from "../../src/lib/index-vaults/native-defaults.ts";
import { legBindings } from "../../src/lib/index-vaults/keeper-tick.ts";

const root = new URL("../fixtures/mag7-cycle/", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("MANIFEST.json", root), "utf8")) as Record<string, string>;
function fixture(name: string) {
  const bytes = gunzipSync(readFileSync(new URL(`${name}.gz`, root)));
  assert.equal(createHash("sha256").update(bytes).digest("hex"), manifest[name], name);
  return bytes;
}
interface Capture { keys: string[]; response: { context: { slot: number }; value: ({ lamports: number; data: [string, string]; owner: string; executable: boolean } | null)[] } }
export interface JsonInstruction { programId: string; data: string; accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[] }
export const ledgerBuild = JSON.parse(fixture("jup-ledger-build.json").toString()).built as {
  tokenLedgerInstruction: JsonInstruction; swapInstruction: JsonInstruction; addressLookupTableAddresses: string[];
};
export const ledgerQuote = JSON.parse(fixture("jup-ledger-quote.json").toString()).quote as {
  inputMint: string; outputMint: string; inAmount: string; outAmount: string; otherAmountThreshold: string;
};
export const exitBuild = JSON.parse(fixture("jup-exit-build.json").toString()).built as {
  swapInstruction: JsonInstruction; addressLookupTableAddresses: string[];
};
export const exitQuote = JSON.parse(fixture("jup-exit-quote.json").toString()).quote as {
  inputMint: string; outputMint: string; inAmount: string; otherAmountThreshold: string;
};
export const pk = (key: string) => new PublicKey(key);
export const owner = snapshot.creator;
// A public test address, never a keypair, never funded outside this in-memory VM.
export const keeper = new PublicKey(new Uint8Array(32).fill(17)).toBase58();
export const vaultAddress = snapshot.vault;
export const shareMint = snapshot.shareMint;
export const intentAddress = getRebalanceIntentPda(pk(vaultAddress), pk(owner)).toBase58();
export { definition, MAINNET_USDC };
export const bindings = [...legBindings(definition.vaultLegs), ...NATIVE_DEFAULT_BINDINGS];
export const decodeInstruction = (ix: JsonInstruction) => new TransactionInstruction({ programId: pk(ix.programId), data: Buffer.from(ix.data, "base64"), keys: ix.accounts.map(k => ({ ...k, pubkey: pk(k.pubkey) })) });

/** Real deployed programs and captured accounts. All funding mutations below are explicitly
 * SYNTHETIC LOCAL TEST INPUTS, not liquidity evidence, production writes, signatures or receipts.
 * compositionVm installs the network-forbidden seam; no RPC is possible here. */
export function mag7CycleVm() {
  const vm = compositionVm();
  const current = JSON.parse(fixture("current-accounts.json").toString()) as Capture;
  function load(capture: Capture, missingOnly: boolean) {
    capture.keys.forEach((id, i) => {
      const a = capture.response.value[i];
      const present = vm.svm.getAccount(address(id));
      if (!a || a.executable || id.startsWith("Sysvar") || (missingOnly && present && "data" in present && present.data.length > 0)) return;
      const data = Buffer.from(a.data[0], "base64");
      vm.svm.setAccount({ address: address(id), lamports: lamports(BigInt(a.lamports)), data, programAddress: address(a.owner), executable: false, space: BigInt(data.length) });
    });
  }
  load(current, false);
  const c = Buffer.from(current.response.value[current.keys.indexOf("SysvarC1ock11111111111111111111111111111111")]!.data[0], "base64");
  vm.svm.setClock(new Clock(c.readBigUInt64LE(0), c.readBigInt64LE(8), c.readBigUInt64LE(16), c.readBigUInt64LE(24), c.readBigInt64LE(32)));
  vm.connection.getTokenSupply = async key => {
    const info = await vm.connection.getAccountInfo(key);
    assert(info);
    const mint = unpackMint(key, info, info.owner);
    return { context: { slot: Number(vm.svm.getClock().slot) }, value: { amount: mint.supply.toString(), decimals: mint.decimals, uiAmount: null } };
  };
  function fundTestSol(key: string) {
    const old = vm.svm.getAccount(address(key));
    vm.svm.setAccount({ address: address(key), lamports: lamports(5_000_000_000n), data: old && "data" in old ? old.data : new Uint8Array(), programAddress: address("11111111111111111111111111111111"), executable: false, space: 0n });
  }
  fundTestSol(owner); fundTestSol(keeper);
  function time(timestamp: number) {
    const c = vm.svm.getClock();
    vm.svm.setClock(new Clock(c.slot, c.epochStartTimestamp, c.epoch, c.leaderScheduleEpoch, BigInt(timestamp)));
  }
  function wire(instructions: TransactionInstruction[], payer = owner) {
    return Buffer.from(new VersionedTransaction(new TransactionMessage({ payerKey: pk(payer), recentBlockhash: vm.svm.latestBlockhash(), instructions }).compileToV0Message()).serialize()).toString("base64");
  }
  function applyPayload(payload: TxPayloadBatchSequence) {
    return payload.batches.flatMap(b => b.transactions.map(t => vm.apply(t.tx_b64)));
  }
  async function testInventory(who: string, mint: string, amount: bigint, program = TOKEN_PROGRAM_ID) {
    const ata = getAta(pk(who), pk(mint), program);
    vm.apply(wire([createAssociatedTokenAccountIdempotentInstruction(pk(who), ata, pk(who), pk(mint), program)], who));
    const a = vm.svm.getAccount(address(ata.toBase58())); assert(a && "data" in a);
    const data = Buffer.from(a.data); data.writeBigUInt64LE(amount, 64);
    vm.svm.setAccount({ ...a, data });
  }
  async function balance(who: string, mint: string, program = TOKEN_PROGRAM_ID) {
    const ata = getAta(pk(who), pk(mint), program);
    const info = await vm.connection.getAccountInfo(ata);
    return info ? unpackAccount(ata, info, program).amount : 0n;
  }
  async function beginDeposit() {
    await testInventory(owner, MAINNET_USDC, 100_000_000n);
    applyPayload(await vm.native.sdk.buyVaultTx({ buyer: owner, vault_mint: shareMint, contributions: [{ mint: MAINNET_USDC, amount: 100_000_000 }], rebalance_slippage_bps: 100, per_trade_rebalance_slippage_bps: 50 }));
    applyPayload(await vm.native.sdk.lockDepositsTx({ buyer: owner, vault_mint: shareMint }));
    const intent = (await vm.native.sdk.fetchRebalanceIntent(intentAddress)).chain_data;
    time(Number(intent.executionStartTime.toString()) + 1);
    applyPayload((await vm.native.priceUpdateFromVault(await vm.native.sdk.fetchVault(vaultAddress), keeper, intentAddress, bindings)).payload);
    return (await vm.native.sdk.fetchRebalanceIntent(intentAddress)).chain_data;
  }
  function loadDex(kind: "ledger" | "exit" = "ledger") {
    load(JSON.parse(fixture(`jup-${kind}-accounts.json`).toString()) as Capture, true);
    const programs = JSON.parse(fixture(`jup-${kind}-programs.json`).toString()).programs as { id: string; sha256: string }[];
    for (const p of programs) {
      const binary = fixture(`${p.id}.so`);
      assert.equal(createHash("sha256").update(binary).digest("hex"), p.sha256);
      vm.svm.addProgramWithLoader(address(p.id), binary, address("BPFLoaderUpgradeab1e11111111111111111111111"));
    }
  }
  return { ...vm, time, wire, applyPayload, testInventory, balance, beginDeposit, loadDex };
}
export type Mag7Vm = ReturnType<typeof mag7CycleVm>;
export async function withVmTime<T>(vm: Mag7Vm, run: () => Promise<T>) {
  const original = Date.now;
  Date.now = () => Number(vm.svm.getClock().unixTimestamp) * 1000;
  try { return await run(); } finally { Date.now = original; }
}
