import assert from "node:assert/strict";
import { test } from "node:test";
import bs58 from "bs58";
import { VersionedTransaction, TransactionMessage, PublicKey, SystemProgram, type VersionedTransactionResponse } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { allSevenVm, definition } from "./support/all-seven-vm.mts";
import { cycleTestPolicy, cycleTestOwner, cycleTestKeeper } from "./support/cycle-policy.mts";
import { localCycleReceipt } from "./support/cycle-receipt-vm.mts";
import { prepareCycleStep } from "../src/lib/index-vaults/cycle-prepare.ts";
import { cycleDb } from "./support/cycle-db.mts";
import { cycleKeeperTick } from "../src/lib/index-vaults/cycle-keeper.ts";
import { CycleRunner } from "../src/lib/index-vaults/cycle-runner.ts";
import { initialCycleState, CycleJournal } from "../src/lib/index-vaults/cycle-store.ts";
import { observeCycle } from "../src/lib/index-vaults/cycle-observer.ts";
import { decodeCycleReceipt } from "../src/lib/index-vaults/cycle-receipts.ts";
import { ed25519 } from "@noble/curves/ed25519";
import { handleCycleRequest } from "../src/lib/index-vaults/cycle-api.ts";
import { sha256 } from "../src/lib/index-vaults/amounts.ts";
import { validateCycleOwnerTransaction } from "../src/lib/frontend/cycle-wallet.ts";
import { auditCycleWalletHistory, readCycleWalletHistory } from "../src/lib/frontend/cycle-history.ts";
import { MAINNET_USDC } from "../src/lib/index-vaults/native-defaults.ts";
import { preflightCycleConnectionRoutes } from "../src/lib/index-vaults/cycle-route-preflight.ts";
import { preflightCycleRoutes } from "../src/lib/index-vaults/cycle-prepare.ts";

test("prefunding rejects malformed weights instead of renormalizing estimates", async () => {
  const policy = cycleTestPolicy();
  const malformed = { ...definition, vaultLegs: definition.vaultLegs.map((leg, n) => n === 0 ? { ...leg, targetWeightBps: leg.targetWeightBps - 1 } : leg) };
  await assert.rejects(preflightCycleConnectionRoutes({} as never, malformed, policy, undefined, []), /Unique mints and integer weights totaling 10000 required/);
  await assert.rejects(preflightCycleRoutes({ connection: {} as never } as never, malformed, policy, undefined, []), /Unique mints and integer weights totaling 10000 required/);
});

test("definition-driven controller uses estimate-based prefunding admission", async () => {
  const realNow = Date.now;
  let database: Awaited<ReturnType<typeof cycleDb>> | undefined;
  try {
    const policy = cycleTestPolicy(), vm = allSevenVm({ owner: policy.owner, keeper: policy.keeper });
    Date.now = vm.now;
    // Synthetic authorization ONLY inside a no-network VM. These are NOT pilot recommendations
    // or captain approvals; no real key, RPC send, production write or wallet is involved.
    policy.notBeforeSlot = Number(vm.svm.getClock().slot);
    policy.expiresAt = vm.now() + 3600000;
    policy.financialExecutionAuthorized = true; policy.approvalReference = "LOCAL-TEST-ONLY-NOT-LIVE-AUTHORITY";
    policy.economics = { keeperSurplus: "native-filler-retains", shareQuantization: "bounded-native-units", residualCash: "native-backing", issuerAuthorityRiskApproved: true, nativeSettlementRiskApproved: true };
    policy.limits.minExitUsdcRaw = "97000000";
    policy.limits.maxOwnerSolDebitLamports = "1000000000"; policy.limits.maxKeeperSolDebitLamports = "1000000000";
    policy.limits.maxKeeperSurplusUsdcRaw = "1000000"; policy.limits.maxBountyRaw = "10000000";
    const record = { ...definition, keeper: { pubkey: policy.keeper, automationEnabled: true } };
    policy.feeScheduleHash = (await observeCycle(vm.native, record, policy)).feeScheduleHash;
    const state = initialCycleState(policy);
    vm.seed(policy.owner, MAINNET_USDC, 100_000_123n);
    for (const l of record.vaultLegs) vm.seed(policy.owner, l.mint, 123n, TOKEN_2022_PROGRAM_ID);
    const input = { native: vm.native, record, policy, state, metadata: vm.metadata };
    database = await cycleDb();
    const journal = new CycleJournal(policy, database.rpc);
    const runner = new CycleRunner({ native: vm.native, policy, journal, loadDefinition: async () => record, metadata: vm.metadata });
    const transactions = new Map<string, VersionedTransactionResponse>();
    vm.connection.isBlockhashValid = async () => ({ context: { slot: Number(vm.svm.getClock().slot) }, value: true });
    vm.connection.getSignaturesForAddress = async (address, options) => {
      const matching = [...transactions.values()].reverse().filter(t => {
        const keys = t.transaction.message.getAccountKeys({ accountKeysFromLookups: t.meta!.loadedAddresses });
        return Array.from({ length: keys.length }, (_, n) => keys.get(n)!.toBase58()).includes(address.toBase58());
      });
      const from = options?.before ? matching.findIndex(t => t.transaction.signatures[0] === options.before) + 1 : 0;
      return matching.slice(from, from + (options?.limit ?? 100)).map(t => ({ signature: t.transaction.signatures[0], slot: t.slot, err: null, memo: null, blockTime: t.blockTime, confirmationStatus: "finalized" }));
    };
    // Program metadata is real local execution. Ordering/validity headers are synthetic, not mainnet finality.
    vm.connection.getBlockSignatures = async () => ({ blockhash: vm.svm.latestBlockhash(), previousBlockhash: vm.svm.latestBlockhash(), parentSlot: Number(vm.svm.getClock().slot) - 1, signatures: [...transactions.keys()], blockTime: null });
    vm.connection.getTransaction = (async (signature: string) => transactions.get(signature) ?? null) as typeof vm.connection.getTransaction;
    vm.connection.getSignatureStatuses = async signatures => ({ context: { slot: Number(vm.svm.getClock().slot) }, value: signatures.map(s => transactions.has(s) ? { slot: transactions.get(s)!.slot, confirmations: null, err: null, confirmationStatus: "finalized" } : null) });
    vm.connection.getBlockHeight = async () => Number(vm.svm.getClock().slot);
    vm.connection.sendRawTransaction = async bytes => {
      const encoded = Buffer.from(bytes).toString("base64"), tx = VersionedTransaction.deserialize(Buffer.from(bytes)), signature = bs58.encode(tx.signatures[0]);
      assert.equal((await journal.read()).pending!.signedTransaction, encoded, "durable latch precedes every local relay");
      const signer = tx.message.staticAccountKeys[0].toBase58() === policy.owner ? cycleTestOwner : cycleTestKeeper;
      transactions.set(signature, await localCycleReceipt(vm, encoded, signer));
      return signature;
    };
    await assert.rejects(prepareCycleStep({ ...input, policy: { ...policy, financialExecutionAuthorized: false }, actor: "owner" }), /EXECUTION_DISABLED/);
    await assert.rejects(prepareCycleStep({ ...input, actor: "owner" }), /KEEPER_SETUP_REQUIRED/);
    const tiny = { ...policy, limits: { ...policy.limits, depositUsdcRaw: "500000" } };
    await assert.rejects(prepareCycleStep({ ...input, policy: tiny, state: initialCycleState(tiny), actor: "keeper" }), /AMOUNT_CANNOT_REPRESENT_MINIMUM_SHARES/);
    const apiEnv = { STOCKLANA_CYCLE_AUTH_SECRET: "SYNTHETIC-LOCAL-ONLY-ACCESS-NOT-LIVE-AUTHORITY", STOCKLANA_CYCLE_POLICIES_JSON: JSON.stringify([policy]) };
    async function api(body: Record<string, unknown>) {
      const response = await handleCycleRequest(new Request("https://insiderindex.xyz/api/vaults/cycle", { method: "POST", headers: { origin: "https://insiderindex.xyz", "content-type": "application/json" }, body: JSON.stringify({ operationId: policy.operationId, ...body }) }), { env: apiEnv, runner: () => runner });
      const result = await response.json(); assert.equal(response.status, 200, JSON.stringify(result)); return result;
    }
    async function execute(actor: "owner" | "keeper", expected: string, request: "next" | "withdraw" = "next") {
      const access = actor === "owner" ? await api({ action: "challenge", wallet: policy.owner }) : null;
      const auth = access ? { token: access.challenge.token, signature: bs58.encode(ed25519.sign(new TextEncoder().encode(access.challenge.message), cycleTestOwner.secretKey.subarray(0, 32))) } : null;
      const prepared = actor === "owner" ? (await api({ action: "prepare", request, auth })).preparation as Awaited<ReturnType<typeof runner.prepare>> : await runner.prepare(actor, request);
      assert.equal(prepared.action, expected, prepared.reason); assert(prepared.pending);
      const p = prepared.pending, chain = await observeCycle(vm.native, record, policy, request === "withdraw" || state.phase === "exiting" ? "recovery" : "strict");
      if (actor === "owner") {
        const walletInput = { connection: vm.connection, policy, record, state: await journal.read(), pending: p, wallet: policy.owner, metadata: vm.metadata };
        await validateCycleOwnerTransaction(walletInput);
        if (expected === "contribute") {
          await assert.rejects(validateCycleOwnerTransaction({ ...walletInput, pending: { ...p, exactInputRaw: "100000001" } }), /CYCLE_WALLET_CONTRIBUTION/);
          await assert.rejects(validateCycleOwnerTransaction({ ...walletInput, state: { ...walletInput.state, ownerSolDebitLamports: "0" } }), /HISTORY_DIVERGENCE/);
          const altered = VersionedTransaction.deserialize(Buffer.from(p.txBase64, "base64"));
          const message = TransactionMessage.decompile(altered.message);
          const malicious = new VersionedTransaction(new TransactionMessage({ ...message, instructions: [...message.instructions, SystemProgram.transfer({ fromPubkey: new PublicKey(policy.owner), toPubkey: new PublicKey(policy.keeper), lamports: 1 })] }).compileToV0Message());
          const changed = { ...p, txBase64: Buffer.from(malicious.serialize()).toString("base64"), messageHash: sha256(malicious.message.serialize()) };
          await assert.rejects(validateCycleOwnerTransaction({ ...walletInput, pending: changed, state: { ...walletInput.state, pending: changed } }), /SEMANTIC_MESSAGE_MISMATCH/, "even a consistent server hash/summary cannot authorize an extra recipient");
        }
        if (expected === "withdraw") await assert.rejects(validateCycleOwnerTransaction({ ...walletInput, pending: { ...p, exactInputRaw: (BigInt(p.exactInputRaw!) + 1n).toString() } }), /BURN_AMOUNT/);
      }
      const signer = actor === "owner" ? cycleTestOwner : cycleTestKeeper, signed = VersionedTransaction.deserialize(Buffer.from(p.txBase64, "base64")); signed.sign([signer]);
      const signedTransaction = Buffer.from(signed.serialize()).toString("base64");
      const submitted = actor === "owner" ? (await api({ action: "submit", auth, signedTransaction })).submission : await cycleKeeperTick(runner, { execute: true, signer: cycleTestKeeper });
      assert("signature" in submitted && typeof submitted.signature === "string");
      const rpc = transactions.get(submitted.signature)!;
      assert.equal(rpc.transaction.signatures[0], bs58.encode(signed.signatures[0]));
      const receipt = decodeCycleReceipt(rpc, { signature: rpc.transaction.signatures[0], messageHash: p.messageHash, payer: p.payer, owner: policy.owner, vault: policy.vault, shareMint: policy.shareMint, operationId: policy.operationId, minSlot: p.minSlot, mints: chain.mintBindings });
      Object.assign(state, actor === "owner" ? (await api({ action: "reconcile", auth })).state : await runner.reconcile());
      assert.equal(state.recoveryRequired, null);
      assert.equal(state.pending, null);
      return receipt;
    }
    const dryState = await journal.read();
    const dry = await cycleKeeperTick(runner); assert.equal(dry.mode, "dry-run");
    assert.deepEqual(await journal.read(), dryState, "dry run does not write a draft or account a rebalance");
    await assert.rejects(cycleKeeperTick(runner, { execute: true, signer: cycleTestOwner }), /EXTERNAL_KEY_REQUIRED/);
    await execute("keeper", "setup-keeper"); await execute("keeper", "setup-keeper");
    assert.equal((await prepareCycleStep({ ...input, actor: "keeper" })).action, "wait");
    for (const l of record.vaultLegs) vm.seed(policy.keeper, l.mint, 321n, TOKEN_2022_PROGRAM_ID);
    vm.seed(policy.keeper, MAINNET_USDC, 5_000_000n);
    await execute("owner", "create");
    await assert.rejects(prepareCycleStep({ ...input, actor: "owner", request: "withdraw" }), /WITHDRAW_REQUIRES_HELD_SHARES/);
    const held = await journal.read();
    await execute("owner", "contribute"); await execute("owner", "lock");
    let intent = (await vm.native.sdk.fetchRebalanceIntent(vm.intent)).chain_data;
    vm.time(Number(intent.executionStartTime.toString()));
    for (let n = 0; n < 10; n++) {
      const plan = await prepareCycleStep({ ...input, actor: "keeper" });
      if (plan.action !== "prices") break;
      await execute("keeper", "prices");
    }
    intent = (await vm.native.sdk.fetchRebalanceIntent(vm.intent)).chain_data;
    for (const [n, offset] of [[0, 57], [0, 71], [1, 34], [2, 17]]) {
      vm.time(Number(intent.auctions[n].startTime.toString()) + offset); await execute("keeper", "fill");
    }
    vm.time(Number(intent.auctions[2].endTime.toString()) + 1);
    await execute("keeper", "mint"); await execute("keeper", "cleanup");
    assert.equal((await prepareCycleStep({ ...input, actor: "owner" })).action, "holding");
    await execute("owner", "withdraw", "withdraw");
    for (let n = 0; n < 10; n++) {
      if ((await prepareCycleStep({ ...input, actor: "owner" })).action !== "claim") break;
      await execute("owner", "claim");
    }
    await execute("owner", "cleanup"); // owner recovery does not require a live keeper
    for (let n = 0; n < 7; n++) await execute("owner", "convert");
    assert.equal((await runner.prepare("owner")).action, "complete");
    const bindings = (await observeCycle(vm.native, record, policy, "recovery")).mintBindings;
    const walletHistory = auditCycleWalletHistory([...transactions.values()], policy, bindings);
    assert.equal(walletHistory.contributedUsdcRaw.toString(), state.contributedUsdcRaw);
    assert.equal(walletHistory.mintedSharesRaw.toString(), state.mintedSharesRaw);
    assert.equal(walletHistory.burnedSharesRaw.toString(), state.burnedSharesRaw);
    assert.equal(walletHistory.recoveredUsdcRaw.toString(), state.recoveredUsdcRaw);
    assert.equal(walletHistory.ownerSolDebitLamports.toString(), state.ownerSolDebitLamports);
    assert.equal(walletHistory.bountyFundingRaw.toString(), state.bountyFundingRaw);
    assert.equal(walletHistory.externalCreditDisposal, false);
    assert([...walletHistory.remainingCredits.values()].every(n => n === 0n));
    assert.equal(auditCycleWalletHistory([...transactions.values()], { ...policy, operationId: "77777777-7777-4777-8777-777777777777" }, bindings).remainingCredits.size, 0, "another operation cannot reuse these claims");
    assert.deepEqual(await readCycleWalletHistory(vm.connection, policy, bindings), walletHistory);
    assert.equal((await journal.read()).phase, "complete");
    assert(BigInt(state.recoveredUsdcRaw) >= BigInt(policy.limits.minExitUsdcRaw));
    assert.equal(await vm.balance(policy.owner, MAINNET_USDC), 123n + BigInt(state.recoveredUsdcRaw));
    assert.equal(await vm.balance(policy.keeper, MAINNET_USDC), 5_000_000n);
    for (const l of record.vaultLegs) {
      assert.equal(await vm.balance(policy.owner, l.mint, TOKEN_2022_PROGRAM_ID), 123n);
      assert(await vm.balance(policy.keeper, l.mint, TOKEN_2022_PROGRAM_ID) >= 321n);
    }
    console.log("LOCAL_CONTROLLER_REPLAY_NOT_LIVE", { minted: state.mintedSharesRaw, recoveredUsdc: state.recoveredUsdcRaw, ownerLamports: state.ownerSolDebitLamports, keeperLamports: state.keeperSolDebitLamports });
  } finally { Date.now = realNow; await database?.close(); }
});
