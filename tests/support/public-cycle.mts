// LOCAL PROGRAM/SQL REPLAY ONLY. None of these budgets, keys, clocks or approvals are live authority.
import assert from "node:assert/strict";
import bs58 from "bs58";
import { ed25519 } from "@noble/curves/ed25519";
import { VersionedTransaction, type VersionedTransactionResponse } from "@solana/web3.js";
import { allSevenVm, definition } from "./all-seven-vm.mts";
import { cycleTestPolicy, cycleTestOwner, cycleTestKeeper } from "./cycle-policy.mts";
import { cycleDb } from "./cycle-db.mts";
import { localCycleReceipt } from "./cycle-receipt-vm.mts";
import { CycleJournal } from "../../src/lib/index-vaults/cycle-store.ts";
import { CycleRunner } from "../../src/lib/index-vaults/cycle-runner.ts";
import { observeCycle } from "../../src/lib/index-vaults/cycle-observer.ts";
import { handlePublicCycleRequest } from "../../src/lib/index-vaults/public-cycle-api.ts";
import { PublicCycleClient } from "../../src/lib/frontend/public-cycle.ts";
import { PUBLIC_MAG7 } from "../../src/lib/index-vaults/public-cycle-parse.ts";

export const publicTestOrigin = "https://insiderindex.xyz";
export const openTestRelease = () => ({ publicFundsEnabled: true, publicInvestSign: true, nativeUsdcExitVerified: true });
export const accessSignature = async (message: string) => bs58.encode(ed25519.sign(new TextEncoder().encode(message), cycleTestOwner.secretKey.subarray(0, 32)));
export const ownerSignature = async (wire: string) => { const tx = VersionedTransaction.deserialize(Buffer.from(wire, "base64")); tx.sign([cycleTestOwner]); return Buffer.from(tx.serialize()).toString("base64"); };
export async function publicCycleFixture(amountRaw = "100000000") {
  const policy = cycleTestPolicy(), vm = allSevenVm({ owner: policy.owner, keeper: policy.keeper });
  const priorNow = Date.now, priorFetch = globalThis.fetch;
  Date.now = vm.now; globalThis.fetch = async () => { throw new Error("NETWORK_FORBIDDEN"); };
  policy.notBeforeSlot = Number(vm.svm.getClock().slot); policy.expiresAt = vm.now() + 3600000;
  policy.financialExecutionAuthorized = true; policy.approvalReference = "LOCAL-TEST-ONLY-NOT-LIVE-AUTHORITY";
  policy.economics = { keeperSurplus: "native-filler-retains", shareQuantization: "bounded-native-units", residualCash: "native-backing", issuerAuthorityRiskApproved: true, nativeSettlementRiskApproved: true };
  Object.assign(policy.limits, { depositUsdcRaw: amountRaw, minExitUsdcRaw: "97000000", maxOwnerSolDebitLamports: "1000000000", maxKeeperSolDebitLamports: "1000000000", maxKeeperSurplusUsdcRaw: "1000000", maxBountyRaw: "10000000" });
  const record = { ...definition, keeper: { pubkey: policy.keeper, automationEnabled: true } };
  assert.equal(record.indexId, PUBLIC_MAG7.indexId);
  policy.feeScheduleHash = (await observeCycle(vm.native, record, policy)).feeScheduleHash;
  const db = await cycleDb(), journal = new CycleJournal(policy, db.rpc);
  const runner = new CycleRunner({ native: vm.native, policy, journal, loadDefinition: async () => record, metadata: vm.metadata });
  const transactions = new Map<string, VersionedTransactionResponse>();
  vm.connection.isBlockhashValid = async () => ({ context: { slot: Number(vm.svm.getClock().slot) }, value: true });
  vm.connection.getSignaturesForAddress = async (address, options) => {
    const rows = [...transactions.values()].reverse().filter(t => {
      const keys = t.transaction.message.getAccountKeys({ accountKeysFromLookups: t.meta!.loadedAddresses });
      return Array.from({ length: keys.length }, (_, n) => keys.get(n)!.toBase58()).includes(address.toBase58());
    });
    const from = options?.before ? rows.findIndex(t => t.transaction.signatures[0] === options.before) + 1 : 0;
    return rows.slice(from, from + (options?.limit ?? 100)).map(t => ({ signature: t.transaction.signatures[0], slot: t.slot, err: null, memo: null, blockTime: t.blockTime, confirmationStatus: "finalized" }));
  };
  vm.connection.getBlockSignatures = async () => ({ blockhash: vm.svm.latestBlockhash(), previousBlockhash: vm.svm.latestBlockhash(), parentSlot: Number(vm.svm.getClock().slot) - 1, signatures: [...transactions.keys()], blockTime: null });
  vm.connection.getTransaction = (async (signature: string) => transactions.get(signature) ?? null) as typeof vm.connection.getTransaction;
  vm.connection.getSignatureStatuses = async signatures => ({ context: { slot: Number(vm.svm.getClock().slot) }, value: signatures.map(s => transactions.has(s) ? { slot: transactions.get(s)!.slot, confirmations: null, err: null, confirmationStatus: "finalized" } : null) });
  vm.connection.getBlockHeight = async () => Number(vm.svm.getClock().slot);
  let sends = 0;
  vm.connection.sendRawTransaction = async bytes => {
    const encoded = Buffer.from(bytes).toString("base64"), tx = VersionedTransaction.deserialize(Buffer.from(bytes)), signature = bs58.encode(tx.signatures[0]);
    assert.equal((await journal.read()).pending!.signedTransaction, encoded, "actual SQL commits exact bytes BEFORE every simulated relay");
    sends++;
    transactions.set(signature, await localCycleReceipt(vm, encoded, tx.message.staticAccountKeys[0].toBase58() === policy.owner ? cycleTestOwner : cycleTestKeeper));
    return signature;
  };
  const env = { STOCKLANA_CYCLE_AUTH_SECRET: "SYNTHETIC-PUBLIC-CYCLE-TEST-NOT-PRODUCTION", STOCKLANA_CYCLE_POLICIES_JSON: JSON.stringify([policy]) };
  const release = openTestRelease(), dependencies = { env, release, runner: (configured: typeof policy) => new CycleRunner({ ...runner.input, policy: configured, journal: new CycleJournal(configured, db.rpc) }) };
  const api = (body: unknown, indexId: string = PUBLIC_MAG7.indexId, origin = publicTestOrigin) => handlePublicCycleRequest(new Request(`${publicTestOrigin}/api/indexes/${indexId}/cycle`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body) }), indexId, dependencies);
  const transport: typeof fetch = async (url, init) => { assert.equal(url, `/api/indexes/${PUBLIC_MAG7.indexId}/cycle`); return api(JSON.parse(String(init?.body))); };
  const client = new PublicCycleClient(policy.owner, publicTestOrigin, { fetch: transport, connection: vm.connection, metadata: vm.metadata });
  const access = async () => { await client.discover(); return client.authorize(accessSignature); };
  return { policy, vm, record, db, journal, runner, env, release, dependencies, api, client, access, transactions, sends: () => sends, close: async () => { Date.now = priorNow; globalThis.fetch = priorFetch; await db.close(); } };
}
