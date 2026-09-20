import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import type { Connection } from "@solana/web3.js";
import type { GlobalConfig, VaultCreationTx } from "@symmetry-hq/sdk";
import { HostFeesLayout } from "@symmetry-hq/sdk/dist/layouts/config.js";
import { ReadOnlyDeployer } from "../src/lib/index-vaults/deployer.ts";
import { rawAmount, sdkRawAmount, canonicalJson, hashObject, sha256, weightsValid } from "../src/lib/index-vaults/amounts.ts";
import { OperationStore, retryDecision } from "../src/lib/index-vaults/operations.ts";
import { VaultRegistry, verifyManifest, verifyMetadata, MANIFEST_DOMAIN } from "../src/lib/index-vaults/registry.ts";
import { remainingSales } from "../src/lib/index-vaults/exit-conversion.ts";
import { nativeNav } from "../src/lib/index-vaults/nav.ts";
import { assessReadiness } from "../src/lib/index-vaults/readiness.ts";
import type { MintReadinessEvidence } from "../src/lib/index-vaults/readiness.ts";
import { NativeVaultBuilders, GENESIS, SYMMETRY_PROGRAM_ID, completeKeepTokens, jupiterDirection, readOnlyConnection, NATIVE_USDC_EXIT_VERIFIED, PUBLIC_FUNDS_ENABLED } from "../src/lib/index-vaults/symmetry-adapter.ts";
import { validateAndSimulate } from "../src/lib/index-vaults/transaction-policy.ts";
import type { TransactionPolicy } from "../src/lib/index-vaults/transaction-policy.ts";
import { evaluateComposition } from "../workers/strategy-service.ts";
import { consumePublishedComposition } from "../src/lib/index-vaults/composition.ts";
import type { PublishedComposition } from "../src/lib/index-vaults/composition.ts";
import type { CandidateAsset, ConfirmedCredit, DeployerAuthorization, DeployerManifest, VaultIdentity, PolicyValidatedComposition } from "../src/lib/index-vaults/adapter-contract.ts";
import { POST as quote } from "../src/app/api/indexes/quote/route.ts";
import { POST as execute } from "../src/app/api/indexes/execute/route.ts";

const key = (n: number) => new PublicKey(new Uint8Array(32).fill(n)).toBase58();
const hash = "a".repeat(64), signature = "2".repeat(88), now = 1_800_000_000_000;
const identity: VaultIdentity = { network: "devnet", programId: SYMMETRY_PROGRAM_ID, vaultAccount: key(2), shareMint: key(3), shareDecimals: 6, hostTreasury: key(4), initialDeployer: key(5), indexId: "execution-test-one", deploymentGeneration: 1, metadataHash: hash };
const asset = (mint = key(6), weight = 10000): CandidateAsset => ({ securityId: mint, ticker: "TEST", provider: "xstocks", mint, tokenProgram: key(7), decimals: 6, targetWeightBps: weight, priceBasis: "base-token", oracle: { kind: "test", account: key(8), denomination: "USDC" }, readiness: "READY", reasons: [], evidence: [] });
const composition = (): PolicyValidatedComposition => ({ indexId: identity.indexId, personId: "execution-test", version: 1, sourceDisclosureHash: hash, manifestHash: hash, policyId: "test", policyHash: hash, validatedAt: new Date(now).toISOString(), validatedByService: "test", decisionEvidenceHash: hash, assets: [asset()], excludedDisclosedAssets: [] });
const published = (c = composition()): PublishedComposition => ({ source: "execution-test", label: "Execution Test — not politician holdings", sourceCompleteness: "complete", published: true, fetchedAt: new Date(now).toISOString(), composition: c });
async function temp<T>(fn: (path: string) => Promise<T>) { const dir = await mkdtemp(join(process.cwd(), ".vault-test-")); try { return await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); } }

test("raw amounts preserve u64, reject floats and unsafe SDK numbers", () => {
  assert.equal(rawAmount("18446744073709551615"), (1n << 64n) - 1n);
  assert.equal(sdkRawAmount("9007199254740991"), Number.MAX_SAFE_INTEGER);
  for (const value of ["01", "-1", "1.5", "1e6", "18446744073709551616"]) assert.throws(() => rawAmount(value));
  assert.throws(() => sdkRawAmount("9007199254740992")); assert.throws(() => rawAmount("0", true));
  assert.equal(hashObject({ b: 2, a: 1 }), hashObject({ a: 1, b: 2 }));
  assert.throws(() => canonicalJson({ missing: undefined }));
});
test("exact weights reject duplicate mint and invalid totals", () => {
  weightsValid([asset()]);
  assert.throws(() => weightsValid([asset(key(6), 5000), asset(key(6), 5000)]));
  assert.throws(() => weightsValid([asset(key(6), 9999)]));
});
test("native redemption keeps inactive and residual slots; vault-relative swap directions reversed", () => {
  const vault = { numTokens: 2, composition: [{ mint: new PublicKey(key(6)), active: 1 }, { mint: new PublicKey(key(9)), active: 0 }] } as Parameters<typeof completeKeepTokens>[0];
  assert.deepEqual(completeKeepTokens(vault, [key(10)]), [key(6), key(9), key(10)]);
  assert.deepEqual(jupiterDirection({ mint_out: key(6), mint_in: key(10) }), { inputMint: key(6), outputMint: key(10) });
});
test("both legacy quote and execute fail closed with no fabricated signature/payload", async () => {
  for (const handler of [quote, execute]) { const response = await handler(); assert.equal(response.status, 503); const body = await response.json(); assert.equal(body.publicFundsEnabled, true); assert.equal(body.signature, undefined); assert.equal(body.transaction, undefined); }
  assert.equal(NATIVE_USDC_EXIT_VERIFIED, false); assert.equal(PUBLIC_FUNDS_ENABLED, true);
});
test("read-only RPC rejects airdrop and broadcast before network", async () => {
  const connection = readOnlyConnection("http://127.0.0.1:1");
  await assert.rejects(connection.requestAirdrop(new PublicKey(key(1)), 1), /Read-only RPC rejects/);
  await assert.rejects(connection.sendRawTransaction(new Uint8Array([1])), /Read-only RPC rejects/);
});

test("operation UUID/idempotency survives restart, rejects duplicate owner intent", async () => temp(async dir => {
  const path = join(dir, "ops.json"), store = new OperationStore(path);
  const input = { identity, owner: key(11), kind: "deposit" as const, amountRaw: "1000000", idempotencyKey: "one" };
  const first = await store.begin(input, false);
  const second = await new OperationStore(path).begin(input, true);
  assert.equal(second.observed.operationId, first.observed.operationId);
  await assert.rejects(store.begin({ ...input, amountRaw: "2" }, false), /Idempotency conflict/);
  await assert.rejects(store.begin({ ...input, idempotencyKey: "two" }, false), /Existing intent/);
  await assert.rejects(store.begin({ ...input, owner: key(12) }, true), /Existing intent/);
}));
test("intent generation receipt replay cannot settle a later intent; shares plus claims stays incomplete", async () => temp(async dir => {
  const store = new OperationStore(join(dir, "ops.json"));
  const row = await store.begin({ identity, owner: key(11), kind: "deposit", amountRaw: "1000000", idempotencyKey: "one" }, false), id = row.observed.operationId;
  await store.bindGeneration(id, key(12), signature, 100);
  await store.recordAttempt(id, { stepId: "mint", messageHash: hash, signature, lastValidBlockHeight: 200, state: "pending" });
  const observed = (await store.get(id)).observed;
  const claims = [{ owner: key(11), mint: key(6), tokenProgram: key(7), amountRemainingRaw: "9", accountExists: false, transferBlocked: false }];
  await assert.rejects(store.applyFinalized(id, { ...observed, intentGeneration: { creationSignature: "3".repeat(88), firstConfirmedSlot: 99 } }, signature, 101), /generation/);
  await assert.rejects(store.applyFinalized(id, { ...observed, phase: "COMPLETE", complete: true, outstandingClaims: claims }, signature, 101), /obligations/);
  const next = { ...observed, phase: "RETURN_PENDING", confirmedSharesReceivedRaw: "999", outstandingClaims: claims };
  await store.applyFinalized(id, next, signature, 101); await store.applyFinalized(id, next, signature, 101);
  assert.equal((await store.get(id)).receiptKeys.length, 1); assert.equal((await store.get(id)).observed.complete, false);
  await assert.rejects(store.recordAttempt(id, { stepId: "mint", messageHash: hash, signature: "3".repeat(88), lastValidBlockHeight: 201, state: "pending" }), /previous attempt/);
}));
test("RPC timeout and expired blockhash never blindly rebuild spend", () => {
  const attempt = { stepId: "buy", messageHash: hash, signature, lastValidBlockHeight: 100, state: "pending" as const };
  assert.equal(retryDecision(attempt, 99, "unknown", true), "rebroadcast-same");
  assert.equal(retryDecision(attempt, 101, "unknown", true), "reconcile");
  assert.equal(retryDecision(attempt, 99, "finalized", true), "reconcile");
});

test("only verified unsold credits can be converted, with a shared wallet cap per mint", () => {
  const credit: ConfirmedCredit = { id: "c1", operationId: "op", mint: key(6), recipientOwner: key(11), tokenProgram: key(7), creditedRaw: "100", soldRaw: "40", signature, instructionIndex: 0, instructionPath: "0/1/account", slot: 100 };
  assert.equal(remainingSales("op", key(11), [credit], [{ mint: key(6), raw: "1000" }], key(10))[0].saleAmountRaw, "60");
  const second = { ...credit, id: "c2", instructionPath: "0/2/account", soldRaw: "0" };
  assert.equal(remainingSales("op", key(11), [credit, second], [{ mint: key(6), raw: "90" }], key(10))[0].saleAmountRaw, "90");
  assert.throws(() => remainingSales("op", key(11), [credit, credit], [], key(10)), /Duplicate/);
  assert.throws(() => remainingSales("op", key(12), [credit], [], key(10)), /Unattributed/);
  assert.throws(() => remainingSales("op", key(11), [{ ...credit, soldRaw: "101" }], [], key(10)), /Oversold/);
});

test("NAV uses effective supply, single multiplier and excludes accounted claims", () => {
  const input = { network: "devnet" as const, vault: key(2), slot: 10, timestamp: now, denomination: "USDC" as const, effectiveSupplyRaw: "1000000", shareDecimals: 6, accountingReconciled: true, liabilitiesQuoteRaw: "100000", quoteDecimals: 6, assets: [{ mint: key(6), activeRaw: "2000000", decimals: 6, priceQuoteRaw: "500000", denomination: "USDC" as const, priceBasis: "scaled-ui-token" as const, multiplierNumerator: "2", multiplierDenominator: "1", multiplierTimestamp: now, priceTimestamp: now }] };
  assert.equal(nativeNav(input, 1000).pricePerShareQuoteRaw, "1900000");
  assert.equal(nativeNav({ ...input, assets: [{ ...input.assets[0], priceBasis: "base-token", priceQuoteRaw: "1000000" }] }, 1000).pricePerShareQuoteRaw, "1900000");
  assert.equal(nativeNav({ ...input, effectiveSupplyRaw: "0" }, 1000).pricePerShareQuoteRaw, null);
  assert.equal(nativeNav({ ...input, accountingReconciled: false }, 1000).navQuoteRaw, null);
  assert.equal(nativeNav({ ...input, assets: [{ ...input.assets[0], priceTimestamp: now - 1001 }] }, 1000).navQuoteRaw, null);
});

function readiness(): MintReadinessEvidence { return { network: "devnet", mint: key(6), tokenProgram: key(7), decimals: 6, catalogVerified: true, extensions: [], testedExtensions: [], freezeAuthority: null, permanentDelegate: null, paused: false, oracleAccount: key(8), oracleSupported: true, priceBasis: "base-token", denomination: "USDC", priceTimestamp: now, confidenceBps: 5, multiplier: null, multiplierTimestamp: null, proxyDivergenceTested: false, vaultTokenSupported: true, depositTransferSimulation: true, claimTransferSimulation: true, usdcToTokenRoute: true, tokenToUsdcRoute: true, buyAmountRaw: "1000000", sellAmountRaw: "1000000", observedSlot: 100, observedAt: now, marketOpen: true }; }
test("readiness is exact-mint and both-directions at intended size; transfers and freshness block", () => {
  const policy = { network: "devnet" as const, now, maxAgeMs: 1000, maxConfidenceBps: 50, buyAmountRaw: "1000000", sellAmountRaw: "1000000" };
  assert.equal(assessReadiness(asset(), readiness(), policy).status, "READY");
  for (const [change, expected] of [[{ tokenToUsdcRoute: false }, "NO_SELL_ROUTE"], [{ buyAmountRaw: "1" }, "NO_BUY_ROUTE"], [{ claimTransferSimulation: false }, "TRANSFER_BLOCKED"], [{ extensions: ["transfer-hook"] }, "EXTENSION_UNSUPPORTED"], [{ priceTimestamp: now - 1001 }, "NO_SUPPORTED_ORACLE"], [{ decimals: 9 }, "UNTESTED"]] as [Partial<MintReadinessEvidence>, string][]) assert.equal(assessReadiness(asset(), { ...readiness(), ...change }, policy).status, expected);
});

test("manifest authenticates names/roles/hash and metadata exact bytes", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const deployer = new PublicKey(publicKey.export({ format: "der", type: "spki" }).subarray(-32)).toBase58();
  const bytes = Buffer.from(JSON.stringify({ name: "Execution Test", symbol: "TEST", description: "Not politician holdings", image: "https://example.com/i", cover: "https://example.com/c" }));
  const manifest: DeployerManifest = { schemaVersion: 3, network: "devnet", deployerPubkey: deployer, hostTreasuryPubkey: key(4), strategyManagerPubkey: key(5), keeperPubkey: key(6), policyId: "test", indexes: [{ indexId: identity.indexId, personId: "execution-test", generation: 1, name: "Execution Test", symbol: "TEST", metadataUri: "https://example.com/metadata.json", metadataSha256: sha256(bytes), admittedMints: [key(7)], allowProvisioning: true, seedUsdcRaw: "0", maxSetupLamportsRaw: "0", startPrice: "1.0", startPriceBasisVerified: false }] };
  const auth: DeployerAuthorization = { manifestHash: hashObject(manifest), signer: deployer, domain: MANIFEST_DOMAIN, authorizationEvidence: { observedSlot: 1, observedAt: new Date(now).toISOString(), source: "unit-test" } };
  const sig = sign(null, Buffer.from(`${MANIFEST_DOMAIN}\n${canonicalJson(manifest)}\n`), privateKey).toString("base64");
  verifyManifest(manifest, auth, sig, deployer, now); verifyMetadata(bytes, manifest.indexes[0]);
  assert.throws(() => verifyManifest({ ...manifest, keeperPubkey: deployer }, auth, sig, deployer, now), /separate/);
  assert.throws(() => verifyManifest({ ...manifest, indexes: [{ ...manifest.indexes[0], name: "Unauthorized" }] }, auth, sig, deployer, now), /hash mismatch/);
  assert.throws(() => verifyMetadata(Buffer.from("{}"), manifest.indexes[0]), /hash mismatch/);
});
test("registry rejects foreign lookalikes, generation conflicts; retired exits stay addressable", async () => temp(async dir => {
  const registry = new VaultRegistry(join(dir, "registry.json"));
  const row = { identity, name: "Execution Test", symbol: "TEST", metadataUri: "https://example.com/m", manifestHash: hash, creationSignature: signature, phase: "RETIRED" as const, observedSlot: 100 };
  const readback = { identity, name: row.name, symbol: row.symbol, metadataUri: row.metadataUri, creator: identity.initialDeployer, host: identity.hostTreasury };
  await assert.rejects(registry.register(row, { ...readback, host: key(20) }), /mismatch/);
  await registry.register(row, readback); await registry.register(row, readback);
  assert.equal((await registry.list()).length, 1);
  assert.equal((await registry.require(identity, "exit")).phase, "RETIRED");
  await assert.rejects(registry.require(identity, "entry"), /Public funds disabled/);
}));

test("strategy keeps last targets on incomplete data, replay, excess churn, unknown mint; delayed valid plan only", () => {
  const current = composition(); current.assets = [asset(key(6), 5000), asset(key(9), 5000)];
  const next = { ...current, version: 2, assets: [asset(key(6), 5500), asset(key(9), 4500)] };
  const policy = { indexId: identity.indexId, policyId: "test", policyHash: hash, manifestHash: hash, admitted: current.assets.map(a => ({ mint: a.mint, oracleAccount: a.oracle.account, tokenProgram: a.tokenProgram, decimals: a.decimals })), maxTurnoverBps: 2000, maxWeightChangeBps: 1000, activationDelaySeconds: 300, maxSourceAgeMs: 1000 };
  assert.equal(evaluateComposition(current, published(next), policy, now, false).decision, "SUBMIT_WEIGHT_INTENT");
  assert.equal(evaluateComposition(current, { ...published(next), sourceCompleteness: "partial" }, policy, now, false).decision, "BLOCKED");
  assert.equal(evaluateComposition(current, published(current), policy, now, false).decision, "NOOP");
  assert.equal(evaluateComposition(current, published(next), policy, now, true).decision, "WAIT");
  assert.equal(evaluateComposition(current, published(next), { ...policy, maxWeightChangeBps: 499 }, now, false).decision, "BLOCKED");
  assert.throws(() => consumePublishedComposition({ ...published(), composition: { ...composition(), personId: "P000197" } }, now, 1000), /impersonate/);
});

function transactionFixture() {
  const payer = new PublicKey(key(11)), recipient = new PublicKey(key(12)), blockhash = key(13);
  const ix = SystemProgram.transfer({ fromPubkey: payer, toPubkey: recipient, lamports: 123 });
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: [ix] }).compileToV0Message());
  const input = { stepId: "test", transactionBase64: Buffer.from(tx.serialize()).toString("base64"), lastValidBlockHeight: 100 };
  const policy: TransactionPolicy = { payer: payer.toBase58(), signers: [payer.toBase58()], programs: [SystemProgram.programId.toBase58()], writableAccounts: [payer.toBase58(), recipient.toBase58()], expectedInstructions: [ix], decode: i => {
    const decoded = SystemProgram.programId.equals(i.programId) ? i.data.readBigUInt64LE(4) : 0n;
    return { debits: [{ owner: payer.toBase58(), mint: "SOL", amountRaw: decoded.toString() }], recipients: [{ owner: recipient.toBase58(), mint: "SOL" }], minima: [] };
  }, maxDebits: [{ owner: payer.toBase58(), mint: "SOL", amountRaw: "123" }], recipients: [{ owner: recipient.toBase58(), mint: "SOL" }], minima: [], maxComputeUnits: 1000000, maxMicroLamports: 25000n };
  let calls = 0;
  const connection = { getBlockHeight: async () => 50, getAddressLookupTable: async () => { throw new Error("unexpected table"); }, simulateTransaction: async () => { calls++; return { context: { slot: 10 }, value: { err: null, logs: [] } }; } } as unknown as Connection;
  return { input, policy, connection, calls: () => calls };
}
test("wire-policy validates exact bytes/accounts and explicit RPC simulation, not SDK summaries", async () => {
  const f = transactionFixture();
  const message = await validateAndSimulate(f.connection, f.input, f.policy);
  assert.equal(message.simulation.ok, true); assert.equal(f.calls(), 1);
  await assert.rejects(validateAndSimulate(f.connection, f.input, { ...f.policy, writableAccounts: [key(11)] }), /writable/);
  await assert.rejects(validateAndSimulate(f.connection, f.input, { ...f.policy, maxDebits: [{ owner: key(11), mint: "SOL", amountRaw: "122" }] }), /Debit exceeds/);
  await assert.rejects(validateAndSimulate(f.connection, f.input, { ...f.policy, recipients: [] }), /recipient/);
  await assert.rejects(validateAndSimulate(f.connection, f.input, { ...f.policy, programs: [] }), /program/);
  await assert.rejects(validateAndSimulate(f.connection, f.input, { ...f.policy, expectedInstructions: [SystemProgram.transfer({ fromPubkey: new PublicKey(key(11)), toPubkey: new PublicKey(key(12)), lamports: 124 })] }), /bytes\/accounts/);
  await assert.rejects(validateAndSimulate(f.connection, { ...f.input, lastValidBlockHeight: 49 }, f.policy), /Expired/);
  assert.equal(f.calls(), 1); // all malformed messages rejected before RPC simulation
});

test("deployer invokes actual pinned SDK create builder with native host fee, and resumes without another mint", async () => temp(async dir => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const deployer = new PublicKey(publicKey.export({ format: "der", type: "spki" }).subarray(-32)).toBase58();
  const bytes = Buffer.from(JSON.stringify({ name: "Execution Test", symbol: "TEST", description: "Not politician holdings", image: "https://example.com/i", cover: "https://example.com/c" }));
  const manifest: DeployerManifest = { schemaVersion: 3, network: "devnet", deployerPubkey: deployer, hostTreasuryPubkey: key(4), strategyManagerPubkey: key(5), keeperPubkey: key(6), policyId: "test", indexes: [{ indexId: identity.indexId, personId: "execution-test", generation: 1, name: "Execution Test", symbol: "TEST", metadataUri: "https://example.com/metadata.json", metadataSha256: sha256(bytes), admittedMints: [key(6)], allowProvisioning: true, seedUsdcRaw: "0", maxSetupLamportsRaw: "0", startPrice: "1.0", startPriceBasisVerified: true }] };
  const auth: DeployerAuthorization = { manifestHash: hashObject(manifest), signer: deployer, domain: MANIFEST_DOMAIN, authorizationEvidence: { observedSlot: 1, observedAt: new Date(now).toISOString(), source: "unit-test-only-not-native-evidence" } };
  const sig = sign(null, Buffer.from(`${MANIFEST_DOMAIN}\n${canonicalJson(manifest)}\n`), privateKey).toString("base64");
  // Only public read methods exist on this fixture; signing/broadcast calls cannot succeed.
  const connection = { getGenesisHash: async () => GENESIS.devnet, getSlot: async () => 1000,
    getLatestBlockhash: async () => ({ blockhash: key(13), lastValidBlockHeight: 1100 }),
    getTokenAccountBalance: async () => ({ context: { slot: 1000 }, value: { amount: "0", decimals: 9, uiAmount: 0 } }),
    getMultipleAccountsInfo: async () => [],
  } as unknown as Connection;
  const native = new NativeVaultBuilders(connection, "devnet");
  native.sdk.fetchGlobalConfig = async () => ({ bountyMint: new PublicKey(key(30)), totalNumberOfVaults: { toString: () => "42" } }) as GlobalConfig;
  const create = native.sdk.createVaultTx.bind(native.sdk);
  const emitted: VaultCreationTx[] = [];
  native.sdk.createVaultTx = async params => { const result = await create(params); emitted.push(result); return result; };
  const inputs = { approvedDeployer: deployer, signatureBase64: sig, metadataBytes: bytes, readinessHash: hash };
  const path = join(dir, "deployments.json");
  const adapter = new ReadOnlyDeployer(native, path, inputs);
  const request = { manifest, indexId: identity.indexId, authorization: auth, composition: { ...composition(), manifestHash: auth.manifestHash } };
  const step = await adapter.prepareInitialize(request);
  assert.deepEqual(step.transactions, []); assert.ok(step.blockers.includes("BROADCAST_DISABLED"));
  await new ReadOnlyDeployer(native, path, inputs).prepareInitialize(request);
  assert.equal(emitted.length, 1);
  const draft = emitted[0]; assert.notEqual(draft.vault, draft.mint);
  const tx = VersionedTransaction.deserialize(Buffer.from(draft.batches[0].transactions[0].tx_b64, "base64"));
  assert.ok(tx.signatures.every(s => s.every(b => b === 0)));
  const instructions = TransactionMessage.decompile(tx.message).instructions;
  const ix = instructions.find(i => i.programId.toBase58() === SYMMETRY_PROGRAM_ID && i.data.length > 72)!;
  assert.ok(ix); assert.equal(new PublicKey(ix.data.subarray(16, 48)).toBase58(), manifest.hostTreasuryPubkey);
  const fees = HostFeesLayout.decode(ix.data.subarray(64, 72));
  assert.equal(fees.hostDepositFeeBps, 25); assert.equal(fees.hostWithdrawalFeeBps, 0);
  assert.equal(fees.hostManagementFeeBps, 0); assert.equal(fees.hostPerformanceFeeBps, 0);
  assert.equal(ix.keys[0].pubkey.toBase58(), deployer);
  assert.equal(ix.keys[1].pubkey.toBase58(), draft.vault); assert.equal(ix.keys[2].pubkey.toBase58(), draft.mint);
  const observed = await adapter.observeProvisioning(identity.indexId, 1);
  assert.equal(observed.creationSignature, undefined); assert.equal(observed.nativeVault, undefined);
}));
