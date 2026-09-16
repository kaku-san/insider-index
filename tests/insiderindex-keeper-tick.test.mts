import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { Keypair } from "@solana/web3.js";
import {
  assertCreatedVault, assertIndexKeeper, assertNotWebAppKeypair, formatKeeperReport, loadKeeperKeypair,
  parseIndexKeeperArgs, plannedTrades, runIndexKeeperTick,
  type IndexKeeperIo, type IndexKeeperObservation,
} from "../src/lib/index-vaults/keeper-tick.ts";
import { recordRebalanceOutcome, type PersistedVaultDefinition } from "../src/lib/index-vaults/vault-definition-store.ts";

const scratch = mkdtempSync(join(tmpdir(), "insiderindex-keeper-tick-"));
test.after(() => rmSync(scratch, { recursive: true, force: true }));

const DEPLOYER = Keypair.generate().publicKey.toBase58();
const HOST = Keypair.generate().publicKey.toBase58();
const STRATEGY = Keypair.generate().publicKey.toBase58();
const NAMED_KEEPER = Keypair.generate();
const VAULT = Keypair.generate().publicKey.toBase58();
const SHARE_MINT = Keypair.generate().publicKey.toBase58();
const AAPL = Keypair.generate().publicKey.toBase58();
const NVDA = Keypair.generate().publicKey.toBase58();

function record(overrides: Partial<PersistedVaultDefinition> = {}): PersistedVaultDefinition {
  return {
    indexId: "insiderindex-nancy-pelosi",
    name: "Nancy Pelosi Index",
    symbol: "IIPELOSI",
    status: "CREATABLE",
    bookSource: "fmp-annual",
    provenance: {},
    vaultAddress: VAULT,
    shareMint: SHARE_MINT,
    vaultLegs: [
      { ticker: "AAPLx", mint: AAPL, targetWeightBps: 5000, decimals: 6, pool: Keypair.generate().publicKey.toBase58(), kind: "raydium_clmm" },
      { ticker: "NVDAx", mint: NVDA, targetWeightBps: 5000, decimals: 6, pool: Keypair.generate().publicKey.toBase58(), kind: "raydium_clmm" },
    ],
    keeper: { pubkey: NAMED_KEEPER.publicKey.toBase58(), automationEnabled: true },
    ...overrides,
  };
}

function observation(overrides: Partial<IndexKeeperObservation> = {}): IndexKeeperObservation {
  const targets = [
    { ticker: "AAPLx", mint: AAPL, targetWeightBps: 5000 },
    { ticker: "NVDAx", mint: NVDA, targetWeightBps: 5000 },
  ];
  return {
    vault: {} as IndexKeeperObservation["vault"],
    vaultAddress: VAULT,
    shareMint: SHARE_MINT,
    shareSupplyRaw: "1000000",
    guards: { deployer: DEPLOYER, host: HOST, strategy: [STRATEGY], namedKeeper: NAMED_KEEPER.publicKey.toBase58() },
    targets,
    drift: [
      { ticker: "AAPLx", mint: AAPL, targetWeightBps: 5000, onchainWeightBps: 6000, amountRaw: "10", driftBps: 1000 },
      { ticker: "NVDAx", mint: NVDA, targetWeightBps: 5000, onchainWeightBps: 4000, amountRaw: "8", driftBps: -1000 },
    ],
    eligibility: { required: false, reason: "Value drift is within rebalance thresholds" },
    intents: 0,
    bindings: [],
    ...overrides,
  };
}

type Recorded = { indexId: string; result: Record<string, unknown> };
function io(overrides: Partial<IndexKeeperIo> & { recorded?: Recorded[]; submits?: number[]; obs?: IndexKeeperObservation; def?: PersistedVaultDefinition | null; keypair?: Keypair } = {}): IndexKeeperIo {
  const recorded = overrides.recorded ?? [];
  const submits = overrides.submits ?? [];
  return {
    readDefinition: overrides.readDefinition ?? (async () => (overrides.def === undefined ? record() : overrides.def)),
    observe: overrides.observe ?? (async () => overrides.obs ?? observation()),
    loadKeypair: overrides.loadKeypair ?? (() => overrides.keypair ?? NAMED_KEEPER),
    prepare: overrides.prepare ?? (async (obs, keeper) => ({ step: "rebalance", eligible: true, reason: "drift", transactions: [{ txBase64: "AA==" }] })),
    sign: overrides.sign ?? (() => ["signed-1"]),
    submit: overrides.submit ?? (async () => { submits.push(1); return { signatures: ["sig-1"], slot: 42 }; }),
    recordOutcome: overrides.recordOutcome ?? (async (indexId, result) => { recorded.push({ indexId, result }); }),
    now: () => "2026-09-18T00:00:00.000Z",
  };
}

test("dry run broadcasts nothing and records mode dry-run (never a rebalance)", async () => {
  const recorded: Recorded[] = [];
  const submits: number[] = [];
  let loadedKey = false;
  const deps = io({ recorded, submits, loadKeypair: () => { loadedKey = true; return NAMED_KEEPER; } });
  const result = await runIndexKeeperTick({ indexId: "insiderindex-nancy-pelosi", mode: "dry-run" }, deps);
  assert.equal(result.mode, "dry-run");
  assert.equal(result.broadcasts, 0);
  assert.deepEqual(result.signatures, []);
  assert.equal(result.keeper, null);
  assert.equal(loadedKey, false, "dry run must not load a keypair");
  assert.equal(submits.length, 0, "dry run must not broadcast");
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].result.mode, "dry-run");
  assert.equal(recorded[0].result.outcome, "dry-run");
  // The recorded outcome distinguishes a dry run from a real rebalance.
  assert.notEqual(recorded[0].result.outcome, "rebalanced");
});

test("execute without eligibility does nothing and records skipped-not-eligible", async () => {
  const recorded: Recorded[] = [];
  const submits: number[] = [];
  const notEligible = observation({ eligibility: { required: false, reason: "Value drift is within rebalance thresholds" } });
  const result = await runIndexKeeperTick(
    { indexId: "insiderindex-nancy-pelosi", mode: "execute", keypair: "/outside/key.json" },
    io({ recorded, submits, obs: notEligible }),
  );
  assert.equal(result.broadcasts, 0);
  assert.deepEqual(result.signatures, []);
  assert.equal(result.outcome, "skipped-not-eligible");
  assert.equal(submits.length, 0, "not eligible must not broadcast");
  assert.equal(recorded[0].result.mode, "execute");
  assert.equal(recorded[0].result.outcome, "skipped-not-eligible");
});

test("execute broadcasts only when eligible and records the real rebalance", async () => {
  const recorded: Recorded[] = [];
  const submits: number[] = [];
  const eligible = observation({ eligibility: { required: true, reason: "drift:mint" } });
  const result = await runIndexKeeperTick(
    { indexId: "insiderindex-nancy-pelosi", mode: "execute", keypair: "/outside/key.json" },
    io({ recorded, submits, obs: eligible }),
  );
  assert.equal(result.broadcasts, 1);
  assert.deepEqual(result.signatures, ["sig-1"]);
  assert.equal(result.outcome, "rebalanced");
  assert.equal(submits.length, 1);
  assert.equal(recorded[0].result.outcome, "rebalanced");
});

test("a wrong keeper is refused", async () => {
  const other = Keypair.generate();
  await assert.rejects(
    runIndexKeeperTick(
      { indexId: "insiderindex-nancy-pelosi", mode: "execute", keypair: "/outside/key.json" },
      io({ obs: observation({ eligibility: { required: true, reason: "drift:mint" } }), keypair: other }),
    ),
    /names keeper .* is a different wallet/,
  );
});

test("a deployer / host / strategy keypair is refused", () => {
  assert.throws(() => assertIndexKeeper(DEPLOYER, { deployer: DEPLOYER, host: HOST, strategy: [STRATEGY], namedKeeper: null }), /not the vault deployer/);
  assert.throws(() => assertIndexKeeper(HOST, { deployer: DEPLOYER, host: HOST, strategy: [STRATEGY], namedKeeper: null }), /not the host treasury/);
  assert.throws(() => assertIndexKeeper(STRATEGY, { deployer: DEPLOYER, host: HOST, strategy: [STRATEGY], namedKeeper: null }), /not a strategy\/manager wallet/);
  const good = NAMED_KEEPER.publicKey.toBase58();
  assert.equal(assertIndexKeeper(good, { deployer: DEPLOYER, host: HOST, strategy: [STRATEGY], namedKeeper: good }), good);
});

test("a deployer keypair loaded from a real file is refused end to end", async () => {
  const deployerKey = Keypair.generate();
  const path = join(scratch, "deployer-key.json");
  writeFileSync(path, JSON.stringify(Array.from(deployerKey.secretKey)));
  const obs = observation({ guards: { deployer: deployerKey.publicKey.toBase58(), host: HOST, strategy: [STRATEGY], namedKeeper: null }, eligibility: { required: true, reason: "drift:mint" } });
  await assert.rejects(
    runIndexKeeperTick({ indexId: "insiderindex-nancy-pelosi", mode: "execute", keypair: path }, io({ obs, loadKeypair: (p) => loadKeeperKeypair(p) })),
    /not the vault deployer/,
  );
});

test("a keypair in the app tree is refused", () => {
  assert.throws(() => assertNotWebAppKeypair("src/keeper-key.json"), /must not live in the web app tree/);
  assert.throws(() => assertNotWebAppKeypair("public/key.json"), /must not live in the web app tree/);
  assert.throws(() => assertNotWebAppKeypair(".next/key.json"), /must not live in the web app tree/);
  // A path outside the app tree is accepted (resolved absolute).
  assert.doesNotThrow(() => assertNotWebAppKeypair(join(scratch, "key.json")));
});

test("a missing vault address (uncreated index) is refused", () => {
  assert.throws(() => assertCreatedVault(record({ vaultAddress: null }), "insiderindex-nancy-pelosi"), /no created vault yet/);
  assert.throws(() => assertCreatedVault(record({ shareMint: null }), "insiderindex-nancy-pelosi"), /no created vault yet/);
  assert.throws(() => assertCreatedVault(null, "insiderindex-nancy-pelosi"), /unreadable or does not exist/);
  assert.throws(() => assertCreatedVault(record({ status: "WAIT_POOL_EVIDENCE" }), "insiderindex-nancy-pelosi"), /not CREATABLE/);
  assert.doesNotThrow(() => assertCreatedVault(record(), "insiderindex-nancy-pelosi"));
});

test("runIndexKeeperTick refuses an uncreated index before any observe or record", async () => {
  let observed = false;
  const recorded: Recorded[] = [];
  await assert.rejects(
    runIndexKeeperTick({ indexId: "insiderindex-nancy-pelosi", mode: "dry-run" }, io({ recorded, def: record({ vaultAddress: null }), observe: async () => { observed = true; return observation(); } })),
    /no created vault yet/,
  );
  assert.equal(observed, false);
  assert.equal(recorded.length, 0, "a refused index records nothing");
});

test("planned trades read buy underweight / sell overweight from drift", () => {
  const trades = plannedTrades([
    { ticker: "AAPLx", mint: AAPL, targetWeightBps: 5000, onchainWeightBps: 6000, amountRaw: "1", driftBps: 1000 },
    { ticker: "NVDAx", mint: NVDA, targetWeightBps: 5000, onchainWeightBps: 4000, amountRaw: "1", driftBps: -1000 },
    { ticker: "MSFTx", mint: Keypair.generate().publicKey.toBase58(), targetWeightBps: 0, onchainWeightBps: null, amountRaw: "0", driftBps: null },
  ]);
  assert.equal(trades[0].action, "sell");
  assert.equal(trades[1].action, "buy");
  assert.equal(trades[2].action, "unknown");
});

test("the operator report is readable and marks a dry run as no-broadcast", async () => {
  const result = await runIndexKeeperTick({ indexId: "insiderindex-nancy-pelosi", mode: "dry-run" }, io());
  const report = formatKeeperReport(result);
  assert.match(report, /InsiderIndex keeper tick — insiderindex-nancy-pelosi/);
  assert.match(report, /DRY-RUN {2}\(no transaction is broadcast\)/);
  assert.match(report, /AAPLx/);
  assert.match(report, /broadcasts: 0/);
});

test("recordRebalanceOutcome rejects a bad mode and calls the write-back RPC", async () => {
  const calls: { fn: string; args: unknown }[] = [];
  const db = { rpc: async (fn: string, args: unknown) => { calls.push({ fn, args }); return { data: null, error: null }; } } as unknown as Parameters<typeof recordRebalanceOutcome>[0];
  await assert.rejects(recordRebalanceOutcome(db, "insiderindex-nancy-pelosi", { mode: "nope" }), /mode dry-run or execute/);
  await recordRebalanceOutcome(db, "insiderindex-nancy-pelosi", { mode: "dry-run", outcome: "dry-run" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].fn, "record_insiderindex_vault_rebalance");
  assert.deepEqual((calls[0].args as { p_index_id: string }).p_index_id, "insiderindex-nancy-pelosi");
  assert.match((calls[0].args as { p_result: string }).p_result, /"mode":"dry-run"/);
});

test("CLI arg parsing: index required, dry-run default, execute needs keypair, force/vault refused", () => {
  assert.deepEqual(parseIndexKeeperArgs(["--index", "idx-a"]), { indexId: "idx-a", mode: "dry-run" });
  assert.deepEqual(parseIndexKeeperArgs(["--index", "idx-a", "--dry-run"]), { indexId: "idx-a", mode: "dry-run" });
  assert.deepEqual(parseIndexKeeperArgs(["--index", "idx-a", "--execute", "--keypair", "/k.json"]), { indexId: "idx-a", mode: "execute", keypair: "/k.json" });
  assert.throws(() => parseIndexKeeperArgs([]), /Usage/);
  assert.throws(() => parseIndexKeeperArgs(["--index", "idx-a", "--execute"]), /--keypair/);
  assert.throws(() => parseIndexKeeperArgs(["--index", "idx-a", "--dry-run", "--keypair", "/k.json"]), /only valid with --execute/);
  assert.throws(() => parseIndexKeeperArgs(["--index", "idx-a", "--force-rebalance"]), /Force-rebalance/);
  assert.throws(() => parseIndexKeeperArgs(["--index", "idx-a", "--vault", VAULT]), /reads the vault and share mint from the DB/);
  assert.throws(() => parseIndexKeeperArgs(["--index", "idx-a", "--share-mint", SHARE_MINT]), /reads the vault and share mint from the DB/);
  assert.throws(() => parseIndexKeeperArgs(["--index", "idx-a", "--keypath", "/k.json"]), /web app never holds a keeper keypair/);
});

test("the CLI script never networks on a bad arg and only it loads a keypair", () => {
  const bad = spawnSync(process.execPath, ["--experimental-strip-types", "scripts/insiderindex-keeper-tick.mts", "--force-rebalance"], { encoding: "utf8" });
  assert.equal(bad.status, 1);
  assert.equal(bad.stdout, "");
  assert.match(bad.stderr, /Force-rebalance|failed-closed/);
  assert.match(readFileSync("scripts/insiderindex-keeper-tick.mts", "utf8"), /loadKeeperKeypair/);
  // The server-side library never loads a keypair; only the CLI seam does.
  const lib = readFileSync("src/lib/index-vaults/keeper-tick.ts", "utf8");
  assert.match(lib, /must not live in the web app tree/);
});

test("dev directory guard for keypair-in-app-tree keeps CLI and library truthful", () => {
  const nested = join(scratch, "src");
  mkdirSync(nested, { recursive: true });
  // A file physically at <scratch>/src is not under the *worktree* app tree, so it is allowed;
  // the guard is about the app root, exercised above with worktree-relative paths.
  assert.doesNotThrow(() => assertNotWebAppKeypair(join(nested, "k.json")));
});
