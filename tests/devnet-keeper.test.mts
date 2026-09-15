import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { PublicKey } from "@solana/web3.js";
import { keeperConfigurationHash, planKeeperObservation } from "../workers/stocklana-keeper.ts";
import type { KeeperSnapshot } from "../workers/stocklana-keeper.ts";
import { DEVNET_KEEPER_IDENTITY, devnetTickReader, runDevnetKeeperTick } from "../workers/devnet-keeper-tick.ts";
import type { DevnetTickReader } from "../workers/devnet-keeper-tick.ts";
import type { StrategyTickInput } from "../workers/strategy-service.ts";
import { GENESIS } from "../src/lib/index-vaults/symmetry-adapter.ts";
import type { CandidateAsset } from "../src/lib/index-vaults/adapter-contract.ts";

const vault = DEVNET_KEEPER_IDENTITY.vaultAccount;
const hash = "a".repeat(64);
const snapshot = (): KeeperSnapshot => ({ vault, configHash: hash, shareSupplyRaw: "0", retired: false, normalRebalanceRequired: null,
  intents: [{ address: "8YE4XGm767rVxFhEYr8snLDxgRf1G9YLCPwPBKD3QBCL", owner: DEVNET_KEEPER_IDENTITY.initialDeployer, type: "deposit", action: "update_prices", bountyLeftRaw: "890000" }] });
const reader = (): DevnetTickReader => ({ network: "devnet", genesis: async () => GENESIS.devnet,
  observe: async previous => planKeeperObservation(snapshot(), previous), balance: async () => ({ slot: 100, lamports: 4807493578 }) });
async function temporary(fn: (path: string) => Promise<void>) {
  await mkdir(join(process.cwd(), ".data"), { recursive: true });
  const directory = await mkdtemp(join(process.cwd(), ".data/keeper-test-"));
  try { await fn(join(directory, "journal.json")); } finally { await rm(directory, { recursive: true, force: true }); }
}
// Synthetic strategy-policy arithmetic only; not admission evidence for this native basket.
function strategy(): StrategyTickInput {
  const key = (n: number) => new PublicKey(new Uint8Array(32).fill(n)).toBase58();
  const asset = (n: number): CandidateAsset => ({ securityId: `test-${n}`, ticker: `TEST${n}`, provider: "xstocks", mint: key(n), tokenProgram: key(3), decimals: 6, targetWeightBps: 5000, priceBasis: "base-token", oracle: { kind: "fixture", account: key(4), denomination: "USD" }, readiness: "READY", reasons: [], evidence: [] });
  const current = { indexId: DEVNET_KEEPER_IDENTITY.indexId, personId: "execution-test", version: 1, sourceDisclosureHash: hash, manifestHash: hash, policyId: "fixture", policyHash: hash, validatedAt: new Date().toISOString(), validatedByService: "fixture", decisionEvidenceHash: hash, assets: [asset(1), asset(2)], excludedDisclosedAssets: [] };
  return { current, published: { source: "execution-test", label: "Execution Test — not politician holdings", published: true, sourceCompleteness: "complete", fetchedAt: new Date().toISOString(), composition: { ...current, version: 2, assets: current.assets.map((a, i) => ({ ...a, targetWeightBps: i ? 4500 : 5500 })) } },
    policy: { indexId: current.indexId, policyId: current.policyId, policyHash: hash, manifestHash: hash, admitted: current.assets.map(a => ({ mint: a.mint, oracleAccount: a.oracle.account, tokenProgram: a.tokenProgram, decimals: a.decimals })), maxTurnoverBps: 1000, maxWeightChangeBps: 1000, activationDelaySeconds: 300, maxSourceAgeMs: 60000 } };
}

test("keeper resumes existing intents before normal eligibility or retired exits", () => {
  assert.equal(planKeeperObservation({ ...snapshot(), normalRebalanceRequired: true, retired: true }).next, "RECONCILE_EXISTING_INTENTS");
  for (const [eligible, expected] of [[true, "NORMAL_REBALANCE_CANDIDATE"], [false, "TARGET_ACTIVE_WAITING"], [null, "NATIVE_ELIGIBILITY_UNAVAILABLE"]] as const) {
    assert.equal(planKeeperObservation({ ...snapshot(), intents: [], normalRebalanceRequired: eligible }).next, expected);
  }
  assert.equal(planKeeperObservation({ ...snapshot(), intents: [], retired: true }).next, "RETIRED_EXITS_ONLY");
});

test("funded locked intent is observed, not repeated, signed or certified settled", () => temporary(async path => {
  const result = await runDevnetKeeperTick(reader(), path);
  assert.equal(result.keeper.intents[0].action, "update_prices");
  assert.equal(result.keeper.shareSupplyRaw, "0");
  assert.equal(result.strategy.decision, "WAIT");
  assert.equal(result.budget.walletLamportsRaw, "4807493578");
  assert.equal(result.budget.tickSpendCapLamportsRaw, "0");
  assert.equal(result.budget.spentLamportsRaw, "0");
  assert.equal(result.signerAuthorization, false);
  assert.deepEqual(result.transactions, []);
  assert.equal(result.broadcasts, 0);
  assert.equal(result.simulation, "NOT_RUN");
  assert.equal(result.settlement, "NOT_CERTIFIED");
  assert.equal(JSON.parse(await readFile(path, "utf8")).observations.length, 1);
}));

test("strategy conflicts wait and valid SUBMIT plans never authorize spending", () => temporary(async path => {
  assert.equal((await runDevnetKeeperTick(reader(), path, strategy())).strategy.decision, "WAIT");
  const idle = reader();
  idle.observe = async previous => planKeeperObservation({ ...snapshot(), intents: [], normalRebalanceRequired: true }, previous);
  const plan = await runDevnetKeeperTick(idle, path, strategy());
  assert.equal(plan.strategy.decision, "SUBMIT_WEIGHT_INTENT");
  assert.equal(plan.signerAuthorization, false);
  assert.equal(plan.budget.authorizedToSpend, false);
  assert.equal(plan.broadcasts, 0);
  assert.deepEqual(plan.transactions, []);
}));

test("incomplete, stale and foreign strategy envelopes cannot replace test targets", () => temporary(async path => {
  const idle = reader();
  idle.observe = async () => planKeeperObservation({ ...snapshot(), intents: [], normalRebalanceRequired: false });
  for (const kind of ["partial", "stale", "identity", "source"]) {
    const input = strategy();
    if (kind === "partial") input.published.sourceCompleteness = "partial";
    if (kind === "stale") input.published.fetchedAt = "2020-01-01T00:00:00Z";
    if (kind === "identity") input.current.indexId = "other";
    if (kind === "source") input.published.source = "fmp-store";
    const result = await runDevnetKeeperTick(idle, path, input);
    assert.equal(result.strategy.decision, "BLOCKED");
    assert.equal(result.broadcasts, 0);
  }
}));

test("configuration drift persists across restart and blocks strategy change", () => temporary(async path => {
  await runDevnetKeeperTick(reader(), path);
  const changed = reader();
  changed.observe = async previous => planKeeperObservation({ ...snapshot(), configHash: "b".repeat(64), intents: [] }, previous);
  const result = await runDevnetKeeperTick(changed, path, strategy());
  assert.ok(result.blockers.includes("CONFIG_CHANGED_REATTEST_REQUIRED"));
  assert.equal(result.strategy.decision, "WAIT");
  const repeat = await runDevnetKeeperTick(changed, path, strategy());
  assert.ok(repeat.blockers.includes("CONFIG_CHANGED_REATTEST_REQUIRED"));
  assert.equal(repeat.strategy.decision, "WAIT");
}));

test("runtime accounting transitions do not latch configuration drift", () => {
  const key = new PublicKey(new Uint8Array(32).fill(7));
  const settings = {
    creator: key, host: key, fees: { hostDepositFeeBps: 25 }, bountyBalance: 1,
    highWaterMark: 2, activeRebalance: 3, activeWithdraws: 4, activeManagements: 5,
    lastAutomationExecutionTimestamp: 6, managersLastUpdateTimestamp: 7, feesLastUpdateTimestamp: 8,
    scheduleLastUpdateTimestamp: 9, automationLastUpdateTimestamp: 10, lpLastUpdateTimestamp: 11,
    metadataLastUpdateTimestamp: 12, forceRebalanceLastUpdateTimestamp: 13,
    customRebalanceLastUpdateTimestamp: 14, addTokenLastUpdateTimestamp: 15,
    updateWeightsLastUpdateTimestamp: 16, makeDirectSwapLastUpdateTimestamp: 17, creationTimestamp: 18,
  };
  const fees = {
    host: key.toBase58(), hostEntryFeeBps: 25, hostExitFeeBps: 0, stocklanaFeesValid: true,
    protocol: { depositFlatBps: 1, depositFeeShareBps: 2, withdrawFlatBps: 3, withdrawFeeShareBps: 4, tradeBps: 5 },
    accruedNativeUnits: { host: "1", creator: "2", managers: "3", protocol: "4" },
    bountyBondRaw: "10", representation: "native-accounting-units; not assumed immediately spendable shares or USDC" as const,
  };
  const vaultState = { settings, numTokens: 1, composition: [{ mint: key, amount: 100, weight: 10_000, active: 1, oracleAggregator: {} }] };
  const initial = keeperConfigurationHash(vaultState as never, fees);
  const transitioned = keeperConfigurationHash({ ...vaultState, settings: { ...settings, bountyBalance: 99, activeRebalance: 30, lastAutomationExecutionTimestamp: 60 }, composition: [{ ...vaultState.composition[0], amount: 999 }] } as never,
    { ...fees, accruedNativeUnits: { host: "9", creator: "8", managers: "7", protocol: "6" } });
  assert.equal(transitioned, initial);
  assert.ok(!planKeeperObservation({ ...snapshot(), configHash: transitioned }, planKeeperObservation({ ...snapshot(), configHash: initial })).blocked.includes("CONFIG_CHANGED_REATTEST_REQUIRED"));
  const changed = keeperConfigurationHash({ ...vaultState, settings: { ...settings, fees: { hostDepositFeeBps: 50 } } } as never, fees);
  assert.notEqual(changed, initial);
});

test("wrong network/genesis fail before observing vault or balance", () => temporary(async path => {
  for (const wrong of [false, true]) {
    const source = reader();
    source.network = wrong ? "devnet" : "mainnet-beta";
    source.genesis = async () => GENESIS["mainnet-beta"];
    source.observe = async () => { assert.fail("must not observe"); };
    source.balance = async () => { assert.fail("must not read balance"); };
    await assert.rejects(runDevnetKeeperTick(source, path), /Devnet/);
  }
}));

test("wrong vault, unsafe balance and RPC errors fail closed without a success journal", () => temporary(async path => {
  for (const scenario of ["vault", "balance", "rpc"]) {
    const source = reader();
    if (scenario === "vault") source.observe = async () => planKeeperObservation({ ...snapshot(), vault: DEVNET_KEEPER_IDENTITY.shareMint });
    if (scenario === "balance") source.balance = async () => ({ slot: 100, lamports: Number.MAX_SAFE_INTEGER + 1 });
    if (scenario === "rpc") source.observe = async () => { throw new Error("RPC unavailable"); };
    await assert.rejects(runDevnetKeeperTick(source, path), /Wrong test vault|Invalid native balance|RPC unavailable/);
    await assert.rejects(readFile(path), { code: "ENOENT" });
  }
}));

test("exclusive lease prevents concurrent ticks, and a failed tick releases it", () => temporary(async path => {
  let entered!: () => void;
  let release!: () => void;
  const start = new Promise<void>(resolve => { entered = resolve; });
  const wait = new Promise<void>(resolve => { release = resolve; });
  const slow = reader();
  slow.observe = async () => { entered(); await wait; throw new Error("RPC failed"); };
  const first = assert.rejects(runDevnetKeeperTick(slow, path), /RPC failed/);
  await start;
  await assert.rejects(runDevnetKeeperTick(reader(), path), { code: "EEXIST" });
  release(); await first;
  assert.equal((await runDevnetKeeperTick(reader(), path)).broadcasts, 0);
}));

test("bounded RPC abort releases the keeper lease", () => temporary(async path => {
  const signal = AbortSignal.timeout(10);
  const stalledFetch = (_input: unknown, init?: RequestInit) => new Promise<never>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
  });
  await assert.rejects(runDevnetKeeperTick(devnetTickReader(signal, stalledFetch as never), path), error => error === signal.reason);
  assert.equal((await runDevnetKeeperTick(reader(), path)).broadcasts, 0);
}));

test("CLI rejects execution, force, mainnet and vault overrides without networking", () => {
  for (const arg of ["--execute", "--force-rebalance", "--network=mainnet-beta", "--vault=other"]) {
    const result = spawnSync(process.execPath, ["--experimental-strip-types", "scripts/devnet-keeper-tick.mts", arg], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Unsupported arguments/);
    assert.equal(result.stdout, "");
  }
});
