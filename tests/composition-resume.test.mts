import test from "node:test";
import assert from "node:assert/strict";
import { VersionedTransaction, TransactionMessage, TransactionInstruction, SystemProgram } from "@solana/web3.js";
import { FailedTransactionMetadata } from "litesvm";
import { compositionVm, definition, snapshot } from "./support/composition-vm.mts";
import { atomicCompositionTransaction } from "../src/lib/index-vaults/composition-transactions.ts";
import { prepareIndexStep, observeIndexVault } from "../src/lib/index-vaults/index-vault-create.ts";
import { kakuSanDeactivateInput, payloadTransactions } from "../src/lib/index-vaults/kaku-san-create.ts";
import { MAINNET_USDC, NATIVE_DEFAULT_BINDINGS } from "../src/lib/index-vaults/native-defaults.ts";
import { WSOL_MINT, assertRaydiumOnlyVault, planRaydiumPriceUpdate } from "../src/lib/index-vaults/raydium-oracles.ts";
import { legBindings, observeIndexVault as observeKeeper, prepareIndexKeeperStep } from "../src/lib/index-vaults/keeper-tick.ts";
import { completeKeepTokens } from "../src/lib/index-vaults/symmetry-adapter.ts";
import { VAULT_RELEASE } from "../src/lib/index-vaults/release.ts";
import { planZapIn, planZapOut } from "../src/lib/index-vaults/zap.ts";
import { snapshotCatalog } from "../src/lib/venues/solana-catalog.ts";
import { nativeNav } from "../src/lib/index-vaults/nav.ts";
import { kakuSanRebalanceEligibility, kakuSanDrift } from "../src/lib/index-vaults/kaku-san-rebalance.ts";
import { rebalanceInputFromVault } from "../src/lib/index-vaults/rebalance-eligibility.ts";
import { mergeIndexObservation, nextIndexStep, resumeIndexReceipt, parseIndexReceipt } from "../src/lib/frontend/index-vault.ts";

test("receipt recovery preserves identity/signatures but not stale progress or cached verification", () => {
  const identity = { indexId: definition.indexId, vaultAddress: snapshot.vault, shareMint: snapshot.shareMint };
  const receipt = { ...resumeIndexReceipt(identity, null)!, signatures: ["4uVycpbdmLWJR5ADkTYcoejkFGDThdTw9PAnw3UNcPMVU2QrmqdhLjbrXUuLEKJ5W4w4h2P7ZHaxYLQoA3CfPyBm"] };
  assert.notEqual(nextIndexStep(receipt, []).step, "create");
  const optimistic = { ...receipt, deactivated: NATIVE_DEFAULT_BINDINGS.map(b => b.mint), added: definition.vaultLegs.map(l => l.mint), weightsSet: true, verified: true };
  assert.equal(parseIndexReceipt(optimistic)!.verified, false);
  const observed = { indexId: definition.indexId, vault: snapshot.vault, shareMint: snapshot.shareMint, exists: true,
    activeMints: [], inactiveDefaults: [], configuredDefaults: [], installedMints: [], pythRemaining: true, weightsSet: false, verified: false };
  const refreshed = mergeIndexObservation(optimistic, observed, optimistic.added);
  assert.deepEqual(refreshed.deactivated, []); assert.deepEqual(refreshed.added, []); assert.equal(refreshed.weightsSet, false);
  assert.deepEqual(refreshed.signatures, receipt.signatures); assert.equal(refreshed.vault, receipt.vault);
  assert.throws(() => resumeIndexReceipt({ ...identity, vaultAddress: snapshot.creator }, receipt), /conflicts/);
  assert.throws(() => resumeIndexReceipt({ ...identity, shareMint: null }, receipt), /Incomplete/);
  assert.deepEqual(nextIndexStep(mergeIndexObservation(refreshed, { ...observed, resumeStep: { step: "weights" } }, []), []), { step: "weights" });
});

const context = { vault: snapshot.vault, manager: snapshot.creator };
const request = { indexId: definition.indexId, creator: snapshot.creator, vault: snapshot.vault, shareMint: snapshot.shareMint };
const load = async () => definition;
const parsed = (base64: string) => VersionedTransaction.deserialize(Buffer.from(base64, "base64"));

// Tests in this file are serial. Every SDK call uses the read-only in-memory Connection seam.
globalThis.fetch = async () => { throw new Error("OFFLINE COMPOSITION TEST: network forbidden"); };

test("real deployed program reproduces 6020; independent execute simulation reproduces missing intent", async () => {
  const vm = compositionVm();
  const valid = kakuSanDeactivateInput(WSOL_MINT);
  const invalid = { ...valid, active: false, oracles: [], min_oracles_thresh: 0, min_conf_bps: 0, conf_thresh_bps: 0, conf_multiplier: 0 };
  const original = await vm.native.sdk.addOrEditTokenTx(context, invalid);
  const bad = vm.simulate(parsed(payloadTransactions(original, snapshot.creator)[0].txBase64));
  assert(bad instanceof FailedTransactionMetadata);
  assert.match(bad.meta().logs().join("\n"), /InvalidOracleWeight.*6020/);
  for (const [token, error] of [
    [{ ...valid, min_oracles_thresh: 0 }, "6025"],
    [{ ...valid, min_conf_bps: 0, conf_thresh_bps: 0, conf_multiplier: 0 }, "6023"],
  ] as const) {
    const payload = await vm.native.sdk.addOrEditTokenTx(context, token);
    const result = vm.simulate(parsed(payloadTransactions(payload, snapshot.creator)[0].txBase64));
    assert(result instanceof FailedTransactionMetadata, `expected native ${error}`);
    assert.match(result.meta().logs().join("\n"), new RegExp(error));
  }
  // Even a real active:false request with VALID oracles is force-active natively.
  const payload = await vm.native.sdk.addOrEditTokenTx(context, { ...valid, active: false });
  const separate = payloadTransactions(payload, snapshot.creator);
  assert.equal(separate.length, 2);
  const missing = vm.simulate(parsed(separate[1].txBase64));
  assert(missing instanceof FailedTransactionMetadata);
  assert.match(missing.meta().logs().join("\n"), /AccountNotInitialized.*3012/);
  const atomic = await atomicCompositionTransaction(vm.native, payload, snapshot.creator);
  vm.apply(atomic.txBase64);
  const vault = await vm.native.sdk.fetchVault(snapshot.vault);
  const sol = vault.composition.find(a => a.mint.toBase58() === WSOL_MINT)!;
  assert.equal(sol.active, 1);
  assert.equal(sol.weight, 5000, "weights are not silently changed during oracle configuration");
});

test("real prepare/observe installs exact Mag7 in the existing identity; no Pyth and zero-target native support", async () => {
  const vm = compositionVm();
  const initial = await observeIndexVault(request, vm.native, load);
  assert.equal(initial.verified, false); assert.equal(initial.pythRemaining, true);
  let receipt = resumeIndexReceipt({ indexId: definition.indexId, vaultAddress: snapshot.vault, shareMint: snapshot.shareMint }, null)!;
  const mints = definition.vaultLegs.map(l => l.mint);
  let simulations = 0;
  for (;;) {
    receipt = mergeIndexObservation(receipt, await observeIndexVault(request, vm.native, load), mints);
    const next = nextIndexStep(receipt, mints);
    if (next.step === "done") break;
    assert.notEqual(next.step, "create", "never recreate a landed vault");
    assert.notEqual(next.step, "observe", "must not stall on native WSOL active");
    assert(next.step !== "create" && next.step !== "observe");
    const prepared = await prepareIndexStep({ ...request, ...next }, vm.native, load);
    assert.equal(prepared.transactions.length, 1);
    assert.equal(prepared.vault, snapshot.vault); assert.equal(prepared.shareMint, snapshot.shareMint);
    vm.apply(prepared.transactions[0].txBase64);
    assert(++simulations <= 10, "resume must converge without repeatedly editing WSOL");
  }
  assert.equal(simulations, 10);
  const vault = await vm.native.sdk.fetchVault(snapshot.vault);
  assert.equal(vault.numTokens, 9);
  assert.equal(vault.settings.activeManagements.toString(), "0");
  for (const leg of definition.vaultLegs) {
    const actual = vault.composition.find(a => a.mint.toBase58() === leg.mint)!;
    assert.equal(actual.weight, leg.targetWeightBps); assert.equal(actual.active, 1);
  }
  assert.equal(vault.composition.find(a => a.mint.toBase58() === WSOL_MINT)!.weight, 0);
  assert.equal(vault.composition.find(a => a.mint.toBase58() === MAINNET_USDC)!.active, 0);
  const keeper = await observeKeeper(definition, vm.native);
  const bindings = [...legBindings(definition.vaultLegs), ...NATIVE_DEFAULT_BINDINGS];
  assert.deepEqual(keeper.bindings, bindings, "actual keeper binds and prices native support slots too");
  assert.equal(assertRaydiumOnlyVault(vault, bindings).length, 9);
  const pricePlan = planRaydiumPriceUpdate({ vault, keeper: snapshot.creator, rebalanceIntent: snapshot.vault, bindings });
  assert.equal(pricePlan.tokenIndices.flat().length, 9, "native prices include support and inactive cash");
  assert.equal(completeKeepTokens(vault).length, 9, "claim list retains every allocated residual, including WSOL");
  // Actual SDK deposit DRAFT: USDC contribution stays USDC; any initial WSOL wrap is the
  // unchanged native bounty/fee machinery, not an investment allocation. No deposit is applied.
  const depositDraft = await vm.native.sdk.buyVaultTx({ buyer: snapshot.creator, vault_mint: snapshot.shareMint, contributions: [{ mint: MAINNET_USDC, amount: 1000000 }], rebalance_slippage_bps: 100, per_trade_rebalance_slippage_bps: 50 });
  const contribution = parsed(payloadTransactions(depositDraft, snapshot.creator).at(-1)!.txBase64);
  assert(contribution.message.staticAccountKeys.some(k => k.toBase58() === MAINNET_USDC));
  assert(!contribution.message.staticAccountKeys.some(k => k.toBase58() === WSOL_MINT));
  assert.equal(VAULT_RELEASE.publicFundsEnabled, true);
  assert.equal(VAULT_RELEASE.publicInvestSign, true);
  const final = await observeIndexVault(request, vm.native, load);
  assert.deepEqual(final.inactiveDefaults, [MAINNET_USDC]);
  assert(final.configuredDefaults!.includes(WSOL_MINT));
  // Mutation controls on real native post-state, not a permissive fabricated success fixture.
  const read = vm.native.sdk.fetchVault.bind(vm.native.sdk);
  for (const mutation of ["positive-sol", "active-usdc", "invalid-usdc-flag", "bad-pool", "pyth", "unknown-mint"] as const) {
    vm.native.sdk.fetchVault = async key => {
      const v = await read(key), sol = v.composition.find(a => a.mint.toBase58() === WSOL_MINT)!;
      if (mutation === "positive-sol") sol.weight = 1;
      if (mutation === "active-usdc") v.composition.find(a => a.mint.toBase58() === MAINNET_USDC)!.active = 1;
      if (mutation === "invalid-usdc-flag") v.composition.find(a => a.mint.toBase58() === MAINNET_USDC)!.active = 2;
      if (mutation === "bad-pool") sol.oracleAggregator.oracles[0].accountsToLoadLutIndices[0] = 0;
      if (mutation === "pyth") sol.oracleAggregator.oracles[0].oracleSettings.oracleType = 0;
      if (mutation === "unknown-mint") sol.mint = v.mint;
      return v;
    };
    assert.equal((await observeIndexVault(request, vm.native, load)).verified, false, mutation);
  }
  vm.native.sdk.fetchVault = read;
  await assert.rejects(prepareIndexStep({ ...request, step: "create" }, vm.native, load), /VAULT_ALREADY_CREATED/);
});

test("a matching half-landed native token intent resumes execution only; mismatches retain the intent", async () => {
  const vm = compositionVm();
  const payload = await vm.native.sdk.addOrEditTokenTx(context, { ...kakuSanDeactivateInput(WSOL_MINT), active: false });
  vm.apply(payloadTransactions(payload, snapshot.creator)[0].txBase64); // historic split-send partial state, simulated only
  await assert.rejects(prepareIndexStep({ ...request, step: "deactivate-default", mint: MAINNET_USDC }, vm.native, load), /RECOVERY_REQUIRED/);
  assert.equal((await vm.native.sdk.fetchVaultIntents(snapshot.vault)).length, 1);
  assert.deepEqual((await observeIndexVault(request, vm.native, load)).resumeStep, { step: "deactivate-default", mint: WSOL_MINT });
  const prepared = await prepareIndexStep({ ...request, step: "deactivate-default", mint: WSOL_MINT }, vm.native, load);
  assert.equal(prepared.transactions.length, 1);
  vm.apply(prepared.transactions[0].txBase64);
  assert.equal((await vm.native.sdk.fetchVault(snapshot.vault)).settings.activeManagements.toString(), "0");
  assert.equal((await vm.native.sdk.fetchVaultIntents(snapshot.vault)).length, 0);
});

test("pending weight intent is discovered despite random SDK seed; stale token settings never get signed", async () => {
  const vm = compositionVm();
  const stale = { ...kakuSanDeactivateInput(WSOL_MINT), conf_thresh_bps: 400 };
  vm.apply(payloadTransactions(await vm.native.sdk.addOrEditTokenTx(context, stale), snapshot.creator)[0].txBase64);
  await assert.rejects(prepareIndexStep({ ...request, step: "deactivate-default", mint: WSOL_MINT }, vm.native, load), /COMPOSITION_ORACLE/);
  assert.equal((await vm.native.sdk.fetchVaultIntents(snapshot.vault)).length, 1, "failed simulation never consumes the pending task");

  const fresh = compositionVm();
  const steps = [
    ...NATIVE_DEFAULT_BINDINGS.map(b => ({ step: "deactivate-default" as const, mint: b.mint })),
    ...definition.vaultLegs.map(l => ({ step: "add-token" as const, mint: l.mint })),
  ];
  for (const step of steps) fresh.apply((await prepareIndexStep({ ...request, ...step }, fresh.native, load)).transactions[0].txBase64);
  const weights = await fresh.native.weights(context, definition.vaultLegs);
  fresh.apply(payloadTransactions(weights, snapshot.creator)[0].txBase64);
  assert.deepEqual((await observeIndexVault(request, fresh.native, load)).resumeStep, { step: "weights" });
  const prepared = await prepareIndexStep({ ...request, step: "weights" }, fresh.native, load);
  fresh.apply(prepared.transactions[0].txBase64);
  assert.equal((await observeIndexVault(request, fresh.native, load)).verified, true);
});

test("null simulated post-state and delayed SDK shape fail closed", async () => {
  const vm = compositionVm();
  const payload = await vm.native.sdk.addOrEditTokenTx(context, kakuSanDeactivateInput(WSOL_MINT));
  await assert.rejects(atomicCompositionTransaction(vm.native, { batches: [payload.batches[0]] }, snapshot.creator), /COMPOSITION_DELAY_OR_SHAPE/);
  const first = parsed(payload.batches[0].transactions[0].tx_b64);
  const luts = await Promise.all(first.message.addressTableLookups.map(async l => (await vm.connection.getAddressLookupTable(l.accountKey)).value!));
  const message = TransactionMessage.decompile(first.message, { addressLookupTableAccounts: luts });
  message.instructions.push(new TransactionInstruction({ programId: SystemProgram.programId, keys: [], data: Buffer.alloc(90) }));
  const tooLarge = structuredClone(payload);
  tooLarge.batches[0].transactions[0].tx_b64 = Buffer.from(new VersionedTransaction(message.compileToV0Message(luts)).serialize()).toString("base64");
  await assert.rejects(atomicCompositionTransaction(vm.native, tooLarge, snapshot.creator), /COMPOSITION_PACKET_TOO_LARGE/);
  const originalSupply = vm.connection.getTokenSupply;
  vm.connection.getTokenSupply = async () => ({ context: { slot: 1 }, value: { amount: "1", decimals: 6, uiAmount: null } });
  await assert.rejects(prepareIndexStep({ ...request, step: "deactivate-default", mint: WSOL_MINT }, vm.native, load), /COMPOSITION_FUNDED/);
  vm.connection.getTokenSupply = originalSupply;
  vm.connection.simulateTransaction = async () => ({ context: { slot: 1 }, value: { err: null, logs: [], accounts: null } });
  await assert.rejects(prepareIndexStep({ ...request, step: "deactivate-default", mint: WSOL_MINT }, vm.native, load), /COMPOSITION_POST_STATE/);
});

test("zero-target WSOL is not zero backing: deposit allocation, pricing, NAV, keeper and USDC-only exit stay distinct", async () => {
  const assets = definition.vaultLegs;
  const quotes = assets.map(l => ({ mint: l.mint, venue: "raydium" as const, inMint: MAINNET_USDC, outMint: l.mint, inAmountRaw: "10000", outAmountRaw: "100" }));
  const deposit = planZapIn({ usdcMint: MAINNET_USDC, usdcAmountRaw: "10000", assets, quotes, catalog: snapshotCatalog().tokens });
  assert.deepEqual(deposit.legs.map(l => Number(l.usdcInRaw)), assets.map(l => l.targetWeightBps));
  assert(!deposit.legs.some(l => l.mint === WSOL_MINT));
  assert(deposit.blockers.includes("BROADCAST_DISABLED"));
  assert.throws(() => planZapIn({ usdcMint: MAINNET_USDC, usdcAmountRaw: "10000", assets: [...assets, { mint: WSOL_MINT, targetWeightBps: 0 }], quotes, catalog: snapshotCatalog().tokens }), /not.*catalog|CATALOG|LOOKALIKE/i);

  // Synthetic residual ONLY, deliberately distinct from the untouched native replay above.
  const vm = compositionVm(), vault = await vm.native.sdk.fetchVault(snapshot.vault);
  const sol = vault.composition.find(a => a.mint.toBase58() === WSOL_MINT)!;
  sol.weight = 0; sol.amount = sol.amount.addn(1000000).muln(1000);
  const observation = kakuSanDrift(vault, assets);
  assert.equal(observation.find(a => a.mint === WSOL_MINT)!.amountRaw, "1000000000");
  const inputs = rebalanceInputFromVault(vault, 1800000000, new Map([[WSOL_MINT, { priceQuote: 100n, validated: true }]]));
  assert.equal(inputs.tokens.find(t => t.mint === WSOL_MINT)!.amountRaw, 1000000000n);
  const eligibility = await kakuSanRebalanceEligibility(vault, vm.connection);
  assert.equal(eligibility.required, null);
  assert.match(eligibility.reason, /nonzero backing.*USDC/);
  const paused = await prepareIndexKeeperStep({ vault, intents: 1 } as Parameters<typeof prepareIndexKeeperStep>[0], snapshot.creator, vm.native);
  assert.equal(paused.eligible, false); assert.deepEqual(paused.transactions, []);
  assert(completeKeepTokens(vault).includes(WSOL_MINT));
  const navInput = { network: "mainnet-beta" as const, vault: snapshot.vault, slot: 1, timestamp: 1000, denomination: "USDC" as const, effectiveSupplyRaw: "1000000", shareDecimals: 6,
    accountingReconciled: true, liabilitiesQuoteRaw: "0", quoteDecimals: 6,
    assets: [{ mint: WSOL_MINT, activeRaw: "1000000000", decimals: 9, priceQuoteRaw: "100000000", denomination: "USDC" as const, priceBasis: "base-token" as const, multiplierNumerator: "1", multiplierDenominator: "1", priceTimestamp: 1000, multiplierTimestamp: 1000 }] };
  assert.equal(nativeNav(navInput, 100).navQuoteRaw, "100000000");
  assert.equal(nativeNav({ ...navInput, accountingReconciled: false }, 100).navQuoteRaw, null);
  const holdings = [{ mint: WSOL_MINT, amountRaw: "1000000000" }, { mint: MAINNET_USDC, amountRaw: "1000000" }];
  assert.throws(() => planZapOut({ usdcMint: MAINNET_USDC, holdings, quotes: [] }), /ZAP_QUOTE_REQUIRED/);
  const exit = planZapOut({ usdcMint: MAINNET_USDC, holdings, quotes: [{ mint: WSOL_MINT, venue: "raydium", inMint: WSOL_MINT, outMint: MAINNET_USDC, inAmountRaw: "1000000000", outAmountRaw: "100000000" }] });
  assert.deepEqual(exit.userReceives, [{ mint: MAINNET_USDC, amountRaw: "101000000" }]);
  assert(exit.blockers.includes("BROADCAST_DISABLED"));
  assert.equal(VAULT_RELEASE.nativeUsdcExitVerified, false);
});
