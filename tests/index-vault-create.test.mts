import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { OracleType } from "@symmetry-hq/sdk/dist/layouts/oracle.js";
import type { Vault } from "@symmetry-hq/sdk";
import { KAKU_SAN_DEFAULT_SLOTS, KAKU_SAN_DEPLOYER, KAKU_SAN_WSOL_MINT } from "../src/lib/index-vaults/kaku-san.ts";
import { VAULT_RELEASE } from "../src/lib/index-vaults/release.ts";
import { GENESIS, NativeVaultBuilders, SYMMETRY_PROGRAM_ID } from "../src/lib/index-vaults/symmetry-adapter.ts";
import type { PersistedVaultDefinition } from "../src/lib/index-vaults/vault-definition-store.ts";
import {
  INDEX_VAULT_DEPLOYER, assertCreatableDefinition, buildIndexPreview, discardIndexCreateDraft,
  handleIndexList, handleIndexPreview, handleIndexPrepare, handleIndexSubmit,
  indexCreateJournal, indexTokenInput, markIndexCreateBroadcast, observeIndexVault, parseIndexDiscardRequest,
  parseIndexPrepareRequest, parseIndexSubmitRequest, prepareIndexStep, recordIndexCreation,
  type CreatableIndexLeg,
} from "../src/lib/index-vaults/index-vault-create.ts";
import {
  applyIndexSubmit, canCreateIndexVault, nextIndexStep, parseIndexReceipt, reconcileIndexCreateDraft,
  saveIndexReceipt, type IndexReceipt,
} from "../src/lib/frontend/index-vault.ts";

async function temp<T>(fn: (path: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(process.cwd(), ".index-vault-test-"));
  try { return await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

register("./support/ui-loader.mjs", import.meta.url);
const { IndexVaultAdmin } = await import("../src/components/index-vault-admin.tsx");
const { PrivySolanaContext } = await import("../src/components/providers/privy-provider.tsx");

const INDEX_ID = "insiderindex-nancy-pelosi";
const VAULT = new PublicKey(new Uint8Array(32).fill(2)).toBase58();
const MINT = new PublicKey(new Uint8Array(32).fill(3)).toBase58();
const OTHER = new PublicKey(new Uint8Array(32).fill(9)).toBase58();
const M1 = new PublicKey(new Uint8Array(32).fill(11)).toBase58();
const M2 = new PublicKey(new Uint8Array(32).fill(12)).toBase58();
const M3 = new PublicKey(new Uint8Array(32).fill(13)).toBase58();
const P1 = new PublicKey(new Uint8Array(32).fill(21)).toBase58();
const P2 = new PublicKey(new Uint8Array(32).fill(22)).toBase58();
const P3 = new PublicKey(new Uint8Array(32).fill(23)).toBase58();

function legs(): PersistedVaultDefinition["vaultLegs"] {
  return [
    { ticker: "AAPLx", mint: M1, provider: "xstock", decimals: 8, pool: P1, kind: "raydium_clmm", tvlUsd: 1_000_000, targetWeightBps: 4000 },
    { ticker: "NVDAx", mint: M2, provider: "xstock", decimals: 8, pool: P2, kind: "raydium_clmm", tvlUsd: 900_000, targetWeightBps: 3500 },
    { ticker: "MSFTx", mint: M3, provider: "backpack", decimals: 8, pool: P3, kind: "raydium_cpmm", tvlUsd: 800_000, targetWeightBps: 2500 },
  ];
}

function fakeDefinition(overrides: Partial<PersistedVaultDefinition> = {}): PersistedVaultDefinition {
  return {
    indexId: INDEX_ID,
    personSlug: "nancy-pelosi",
    network: "mainnet-beta",
    name: "Nancy Pelosi · InsiderIndex",
    symbol: "IIPELOSI",
    status: "CREATABLE",
    weightBasis: "annual-holding-value-midpoint",
    nativeTokenCap: 100,
    structurallyCreatable: true,
    blockedReasons: [],
    bookSource: "fmp-annual",
    provenance: { fmpYear: 2025 },
    hostEntryFeeBps: 25,
    hostExitFeeBps: 0,
    coverage: { tickerCount: 10, mappedLegCount: 3, vaultReadyLegCount: 3, mappableByWeightBps: 9690, unmappedByWeightBps: 310, poolReadyOfMappedBps: 10000 },
    poolExcludedLegs: [],
    vaultAddress: null,
    shareMint: null,
    vaultLegs: legs(),
    keeper: { pubkey: null, automationEnabled: false },
    ...overrides,
  };
}

const loader = (def: PersistedVaultDefinition | null) => async () => def;

function unsignedPayload(payer = KAKU_SAN_DEPLOYER) {
  const payerKey = new PublicKey(payer);
  const message = new TransactionMessage({
    payerKey, recentBlockhash: PublicKey.default.toBase58(),
    instructions: [SystemProgram.transfer({ fromPubkey: payerKey, toPubkey: payerKey, lamports: 1 })],
  }).compileToV0Message();
  const tx = new VersionedTransaction(message);
  return { tx_b64: Buffer.from(tx.serialize()).toString("base64"), payer, message_version: "0" as const, recent_blockhash: "", lookup_tables: [] as string[], instructions: [] };
}

function builders(vaultAccount: { data?: Uint8Array; owner?: PublicKey } | null = { data: new Uint8Array(1) }, fetched: Vault | null = null): NativeVaultBuilders {
  const payload = { batches: [{ transactions: [unsignedPayload()] }] };
  return {
    network: "mainnet-beta",
    connection: {
      simulateTransaction: async () => ({ value: { err: null } }),
      getAccountInfo: async () => vaultAccount,
      getLatestBlockhash: async () => ({ blockhash: PublicKey.default.toBase58(), lastValidBlockHeight: 1 }),
    },
    assertNetwork: async () => {},
    sdk: {
      createVaultTx: async () => ({ vault: VAULT, mint: MINT, ...payload }),
      addOrEditTokenTx: async () => payload,
      fetchVault: async () => fetched ?? verifiedVault(),
    },
    addToken: async () => payload,
    weights: async () => payload,
  } as unknown as NativeVaultBuilders;
}

function raydiumOracle(poolIndex: number) {
  return { oracleSettings: { oracleType: OracleType.RaydiumClmm, numRequiredAccounts: 1 }, accountsToLoadLutIds: [0], accountsToLoadLutIndices: [poolIndex] };
}
/** A vault whose composition matches the definition: defaults deactivated, three legs active on their
 *  target weights with a Raydium oracle, no Pyth. */
function verifiedVault(): Vault {
  const lut = [M1, M2, M3].map(m => new PublicKey(m));
  const defaults = KAKU_SAN_DEFAULT_SLOTS.map(slot => ({
    mint: new PublicKey(slot.mint), amount: 0n, weight: 0, active: 0,
    oracleAggregator: { numOracles: 0, oracles: [] },
  }));
  const active = legs().map((leg, index) => ({
    mint: new PublicKey(leg.mint), amount: 0n, weight: leg.targetWeightBps, active: 1,
    oracleAggregator: { numOracles: 1, oracles: [raydiumOracle(index)] },
  }));
  const composition = [...defaults, ...active];
  return { ownAddress: new PublicKey(VAULT), mint: new PublicKey(MINT), numTokens: composition.length, composition, lutPubkeys: [{ state: { addresses: lut } }] } as unknown as Vault;
}

const request = (body: unknown, path = "/api/vaults/index/prepare") => new Request(`http://localhost${path}`, { method: "POST", body: JSON.stringify(body) });

test("creation builds from the persisted definition, not from Kaku San constants", async () => temp(async dir => {
  const journal = indexCreateJournal(INDEX_ID, join(dir, "index-create.json"));
  const prepared = await prepareIndexStep({ creator: KAKU_SAN_DEPLOYER, indexId: INDEX_ID, step: "create" }, builders(), loader(fakeDefinition()), true, journal);
  assert.equal(prepared.indexId, INDEX_ID);
  assert.equal(prepared.name, "Nancy Pelosi · InsiderIndex");
  assert.equal(prepared.symbol, "IIPELOSI");
  assert.equal(prepared.vault, VAULT);
  assert.equal(prepared.shareMint, MINT);
  assert.equal(prepared.hostEntryFeeBps, 25);
  assert.equal(prepared.hostExitFeeBps, 0);
  assert.deepEqual(prepared.legs.map(l => l.ticker), ["AAPLx", "NVDAx", "MSFTx"]);
  assert.equal(prepared.legs.reduce((s, l) => s + l.targetWeightBps, 0), 10_000);
  // Not the fixed 5-stock 2000 bps basket.
  assert.notEqual(prepared.legs.length, 5);
  assert.doesNotMatch(prepared.name, /Kaku San/);
  // Add-token and weights build from the definition legs.
  const weights = await prepareIndexStep({ creator: KAKU_SAN_DEPLOYER, indexId: INDEX_ID, step: "weights", vault: VAULT, shareMint: MINT }, builders(), loader(fakeDefinition()), true, journal);
  assert.equal(weights.step, "weights");
  const addToken = await prepareIndexStep({ creator: KAKU_SAN_DEPLOYER, indexId: INDEX_ID, step: "add-token", vault: VAULT, shareMint: MINT, mint: M2 }, builders(), loader(fakeDefinition()), true, journal);
  assert.equal(addToken.mint, M2);
}));

test("only the approved deployer may prepare, submit, observe or discard", async () => temp(async dir => {
  const journal = indexCreateJournal(INDEX_ID, join(dir, "index-create.json"));
  assert.equal(canCreateIndexVault({ mode: "live", authenticated: true, solanaAddress: KAKU_SAN_DEPLOYER }), true);
  assert.equal(canCreateIndexVault({ mode: "live", authenticated: true, solanaAddress: OTHER }), false);
  assert.equal(canCreateIndexVault({ mode: "stub", authenticated: true, solanaAddress: KAKU_SAN_DEPLOYER }), false);
  assert.throws(() => parseIndexPrepareRequest({ creator: OTHER, indexId: INDEX_ID }), /approved deployer/);
  assert.throws(() => parseIndexPrepareRequest({ creator: KAKU_SAN_DEPLOYER }), /Index id required/);
  assert.throws(() => parseIndexPrepareRequest({ creator: KAKU_SAN_DEPLOYER, indexId: INDEX_ID, keypair: "/tmp/id.json" }), /Unexpected create field/);
  assert.throws(() => parseIndexSubmitRequest({ creator: OTHER, indexId: INDEX_ID, step: "create", vault: VAULT, shareMint: MINT, signedTransactions: ["AA"] }), /approved deployer/);
  const denied = await handleIndexPrepare(request({ creator: OTHER, indexId: INDEX_ID }), () => builders(), loader(fakeDefinition()));
  assert.equal(denied.status, 400);
  assert.equal(denied.headers.get("Cache-Control"), "no-store");
  const ok = await handleIndexPrepare(request({ creator: KAKU_SAN_DEPLOYER, indexId: INDEX_ID }), () => builders(), loader(fakeDefinition()), undefined);
  assert.equal(ok.status, 200);
  void journal;
}));

test("an unsigned or foreign-signed request is refused", async () => temp(async dir => {
  const journal = indexCreateJournal(INDEX_ID, join(dir, "index-create.json"));
  // Submit with unsigned bytes never broadcasts (503, and the send stub throws if reached).
  const unsigned = await handleIndexSubmit(
    request({ creator: KAKU_SAN_DEPLOYER, indexId: INDEX_ID, step: "create", vault: VAULT, shareMint: MINT, signedTransactions: [unsignedPayload().tx_b64] }, "/api/vaults/index/submit"),
    () => ({ getGenesisHash: async () => GENESIS["mainnet-beta"], sendRawTransaction: async () => { throw new Error("should not send"); } } as never),
    async () => { throw new Error("should not write back an unsigned create"); },
  );
  assert.equal(unsigned.status, 503);
  // Discard requires the deployer Ed25519 signature: unsigned authorization is refused.
  assert.throws(() => parseIndexDiscardRequest({ creator: KAKU_SAN_DEPLOYER, indexId: INDEX_ID, vault: VAULT, shareMint: MINT, signedTransaction: unsignedPayload().tx_b64 }), /unsigned/);
  const kp = Keypair.generate();
  const foreign = new VersionedTransaction(new TransactionMessage({
    payerKey: kp.publicKey, recentBlockhash: PublicKey.default.toBase58(),
    instructions: [SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: kp.publicKey, lamports: 1 })],
  }).compileToV0Message());
  foreign.sign([kp]);
  assert.throws(() => parseIndexDiscardRequest({ creator: KAKU_SAN_DEPLOYER, indexId: INDEX_ID, vault: VAULT, shareMint: MINT, signedTransaction: Buffer.from(foreign.serialize()).toString("base64") }), /approved deployer/);
  void journal;
}));

test("cap violation throws rather than truncating the book", () => {
  const tooMany = Array.from({ length: 101 }, (_, i) => ({
    ticker: `T${i}`, mint: new PublicKey(new Uint8Array(32).fill((i % 200) + 30)).toBase58(),
    provider: "xstock", decimals: 8, pool: P1, kind: "raydium_clmm", tvlUsd: 1, targetWeightBps: 99,
  }));
  assert.throws(() => assertCreatableDefinition(fakeDefinition({ vaultLegs: tooMany }), INDEX_ID), /NATIVE_TOKEN_CAP/);
});

test("refuses clearly: unreadable definition, non-CREATABLE status, and no pool-ready legs", () => {
  assert.throws(() => assertCreatableDefinition(null, INDEX_ID), /not readable/);
  assert.throws(() => assertCreatableDefinition(fakeDefinition({ status: "WAIT_POOL_EVIDENCE", blockedReasons: [] }), INDEX_ID), /WAIT_POOL_EVIDENCE.*not creatable/);
  assert.throws(() => assertCreatableDefinition(fakeDefinition({ status: "BLOCKED", blockedReasons: ["txn-derived-book"] }), INDEX_ID), /txn-derived-book/);
  assert.throws(() => assertCreatableDefinition(fakeDefinition({ vaultLegs: [] }), INDEX_ID), /no pool-ready legs/);
  assert.throws(() => assertCreatableDefinition(fakeDefinition({ vaultLegs: [legs()[0]] }), INDEX_ID), /at least 2/);
  // Weights that do not total 10000 are refused (no silent re-weighting).
  const skewed = legs().map((l, i) => ({ ...l, targetWeightBps: i === 0 ? 5000 : l.targetWeightBps }));
  assert.throws(() => assertCreatableDefinition(fakeDefinition({ vaultLegs: skewed }), INDEX_ID));
});

test("token input installs a Raydium oracle only and rejects a Pyth or mismatched pool", () => {
  const def = assertCreatableDefinition(fakeDefinition(), INDEX_ID);
  const leg: CreatableIndexLeg = def.legs[0];
  const token = indexTokenInput(leg);
  assert.equal(token.oracles[0].oracle_type, "raydium_clmm");
  assert.equal(token.oracles[0].account, P1);
  assert.equal(token.active, true);
});

test("preview shows catalog vs tradable coverage and calls out pool-excluded legs", () => {
  const excluded = fakeDefinition({
    coverage: { tickerCount: 10, mappedLegCount: 4, vaultReadyLegCount: 3, mappableByWeightBps: 9690, unmappedByWeightBps: 310, poolReadyOfMappedBps: 7000 },
    poolExcludedLegs: [{ ticker: "TSLAx", mint: OTHER, reason: "no-observed-pool" }],
  });
  const preview = buildIndexPreview(excluded, INDEX_ID);
  assert.equal(preview.creatable, true);
  assert.equal(preview.name, "Nancy Pelosi · InsiderIndex");
  // Deposits stay closed by default; creating never opens them.
  assert.equal(preview.depositsEnabled, false);
  assert.equal(preview.legCount, 3);
  assert.equal(preview.coverage.mappedLegCount, 4);
  assert.equal(preview.coverage.vaultReadyLegCount, 3);
  assert.equal(preview.coverage.poolReadyOfMappedBps, 7000);
  assert.equal(preview.poolExcludedLegs.length, 1);
  assert.equal(preview.poolExcludedLegs[0].ticker, "TSLAx");
  // A non-creatable definition is still previewable, with the refuse reason surfaced.
  const blocked = buildIndexPreview(fakeDefinition({ status: "WAIT_POOL_EVIDENCE" }), INDEX_ID);
  assert.equal(blocked.creatable, false);
  assert.match(blocked.refuseReason ?? "", /not creatable/);
});

test("the vault address is written back to the definition after a confirmed create", async () => {
  const writes: { indexId: string; vault: string; shareMint: string; receipt: Record<string, unknown> }[] = [];
  const writeBack = async (indexId: string, vault: string, shareMint: string, receipt: Record<string, unknown>) => {
    writes.push({ indexId, vault, shareMint, receipt });
  };
  await recordIndexCreation(writeBack, { indexId: INDEX_ID, vault: VAULT, shareMint: MINT, creator: KAKU_SAN_DEPLOYER, signatures: ["sig1"], slot: 42 });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].indexId, INDEX_ID);
  assert.equal(writes[0].vault, VAULT);
  assert.equal(writes[0].shareMint, MINT);
  assert.deepEqual(writes[0].receipt.signatures, ["sig1"]);
  assert.equal(writes[0].receipt.slot, 42);
  assert.equal(writes[0].receipt.network, "mainnet-beta");
});

test("submit only writes back on the create step, and a lost draft aborts before broadcast", async () => temp(async dir => {
  const journal = indexCreateJournal(INDEX_ID, join(dir, "index-create.json"));
  await prepareIndexStep({ creator: KAKU_SAN_DEPLOYER, indexId: INDEX_ID, step: "create" }, builders(null), loader(fakeDefinition()), true, journal);
  // A concurrent discard clears the draft; the in-flight submit's latch must throw before sending.
  assert.equal((await discardIndexCreateDraft({ creator: KAKU_SAN_DEPLOYER, indexId: INDEX_ID, vault: VAULT, shareMint: MINT }, builders(null), journal)).discarded, true);
  await assert.rejects(markIndexCreateBroadcast(INDEX_ID, VAULT, MINT, journal), /discarded before it could be broadcast/);
}));

test("discard refuses once broadcast or once the vault is a real Symmetry vault; deposits never open", async () => temp(async dir => {
  const journal = indexCreateJournal(INDEX_ID, join(dir, "index-create.json"));
  const native = builders(null);
  await prepareIndexStep({ creator: KAKU_SAN_DEPLOYER, indexId: INDEX_ID, step: "create" }, native, loader(fakeDefinition()), true, journal);
  await markIndexCreateBroadcast(INDEX_ID, VAULT, MINT, journal);
  await assert.rejects(discardIndexCreateDraft({ creator: KAKU_SAN_DEPLOYER, indexId: INDEX_ID, vault: VAULT, shareMint: MINT }, native, journal), /already broadcast/);
  // Deposits and public Invest Sign are default-closed and creating a vault never opens them.
  assert.equal(VAULT_RELEASE.publicFundsEnabled, false);
  assert.equal(VAULT_RELEASE.publicInvestSign, false);
  assert.equal(VAULT_RELEASE.status, "WAIT_FULL_CYCLE_RECEIPT");
}));

test("discard refuses a draft whose vault is program-owned on-chain", async () => temp(async dir => {
  const journal = indexCreateJournal(INDEX_ID, join(dir, "index-create.json"));
  await prepareIndexStep({ creator: KAKU_SAN_DEPLOYER, indexId: INDEX_ID, step: "create" }, builders(null), loader(fakeDefinition()), true, journal);
  const confirmed = builders({ data: new Uint8Array(1), owner: new PublicKey(SYMMETRY_PROGRAM_ID) });
  await assert.rejects(discardIndexCreateDraft({ creator: KAKU_SAN_DEPLOYER, indexId: INDEX_ID, vault: VAULT, shareMint: MINT }, confirmed, journal), /exists on-chain/);
}));

test("observe reports missing accounts and verifies the definition composition", async () => {
  const missing = await observeIndexVault({ indexId: INDEX_ID, vault: VAULT, shareMint: MINT }, builders(null), loader(fakeDefinition()));
  assert.equal(missing.exists, false);
  assert.equal(missing.verified, false);
  const ok = await observeIndexVault({ indexId: INDEX_ID, vault: VAULT, shareMint: MINT }, builders(), loader(fakeDefinition()));
  assert.equal(ok.exists, true);
  assert.equal(ok.verified, true);
  assert.equal(ok.pythRemaining, false);
  assert.deepEqual(ok.activeMints.sort(), [M1, M2, M3].sort());
  const denied = await handleIndexPreview(request({ creator: OTHER, indexId: INDEX_ID }, "/api/vaults/index/preview"), loader(fakeDefinition()));
  assert.equal(denied.status, 400);
});

test("HTTP list refuses non-deployers and returns the definitions for the selector", async () => {
  const denied = await handleIndexList(request({ creator: OTHER }, "/api/vaults/index/list"), async () => []);
  assert.equal(denied.status, 400);
  const ok = await handleIndexList(request({ creator: KAKU_SAN_DEPLOYER }, "/api/vaults/index/list"), async () => [
    { indexId: INDEX_ID, name: "Nancy Pelosi · InsiderIndex", symbol: "IIPELOSI", status: "CREATABLE", structurallyCreatable: true, coverage: {}, vaultAddress: null, shareMint: null },
  ]);
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.definitions.length, 1);
  assert.equal(body.definitions[0].indexId, INDEX_ID);
});

test("receipt step machine walks create → defaults → legs → weights → observe → done", () => {
  const memory = new Map<string, string>();
  globalThis.localStorage = {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => { memory.set(key, value); },
    removeItem: (key: string) => { memory.delete(key); },
  } as unknown as Storage;
  const legMints = [M1, M2, M3];
  assert.equal(nextIndexStep(null, legMints).step, "create");
  let receipt: IndexReceipt = saveIndexReceipt({ indexId: INDEX_ID, vault: VAULT, shareMint: MINT, signatures: [], slot: null, created: false, deactivated: [], added: [], weightsSet: false, verified: false });
  assert.equal(nextIndexStep(receipt, legMints).step, "create");
  receipt = applyIndexSubmit(receipt, { step: "create", indexId: INDEX_ID, vault: VAULT, shareMint: MINT, signatures: ["c"], slot: 1, writtenBack: true });
  assert.equal(receipt.created, true);
  assert.equal(nextIndexStep(receipt, legMints).step, "deactivate-default");
  for (const slot of KAKU_SAN_DEFAULT_SLOTS) receipt = applyIndexSubmit(receipt, { step: "deactivate-default", indexId: INDEX_ID, vault: VAULT, shareMint: MINT, signatures: ["d"], slot: 2, writtenBack: false }, slot.mint);
  assert.equal((nextIndexStep(receipt, legMints) as { mint?: string }).mint, M1);
  for (const mint of legMints) receipt = applyIndexSubmit(receipt, { step: "add-token", indexId: INDEX_ID, vault: VAULT, shareMint: MINT, signatures: ["a"], slot: 3, writtenBack: false }, mint);
  assert.equal(nextIndexStep(receipt, legMints).step, "weights");
  receipt = applyIndexSubmit(receipt, { step: "weights", indexId: INDEX_ID, vault: VAULT, shareMint: MINT, signatures: ["w"], slot: 4, writtenBack: false });
  assert.equal(nextIndexStep(receipt, legMints).step, "observe");
  // A second create for a different vault is refused (never a second vault).
  assert.throws(() => applyIndexSubmit(receipt, { step: "create", indexId: INDEX_ID, vault: OTHER, shareMint: MINT, signatures: ["x"], slot: 5, writtenBack: true }), /second vault/);
  assert.equal(parseIndexReceipt({ indexId: INDEX_ID, vault: VAULT }), null);
  // Reconcile adopts a fresh server draft when the local one no longer matches.
  const reconciled = reconcileIndexCreateDraft(receipt, { indexId: INDEX_ID, vault: OTHER, shareMint: MINT });
  assert.equal(reconciled.vault, OTHER);
  assert.equal(reconciled.created, false);
});

type TestWallet = {
  ready: boolean; configured: boolean; mode: "live" | "stub" | "unavailable"; authenticated: boolean;
  previewConnection: boolean; solanaAddress: string | null; appId: string | null;
  connectionMethod: "wallet" | "email" | null; connect: () => Promise<void>; disconnect: () => Promise<void>;
  signTransaction: (transaction: string, network?: "mainnet-beta" | "devnet") => Promise<string>;
  signAndSendTransaction: (transaction: string, network?: "mainnet-beta" | "devnet") => Promise<string>;
};
function wallet(partial: Partial<TestWallet>): TestWallet {
  return {
    ready: true, configured: true, mode: "live", authenticated: true, previewConnection: false,
    solanaAddress: OTHER, appId: "test", connectionMethod: null,
    connect: async () => {}, disconnect: async () => {},
    signTransaction: async () => { throw new Error("test wallet does not sign"); },
    signAndSendTransaction: async () => { throw new Error("test wallet does not sign"); },
    ...partial,
  };
}
function renderAdmin(value: TestWallet) {
  return renderToStaticMarkup(createElement(PrivySolanaContext.Provider, { value }, createElement(IndexVaultAdmin) as ReactNode));
}

test("admin refuses any other wallet and never leaks Kaku San basket constants or opens deposits", () => {
  assert.equal(INDEX_VAULT_DEPLOYER, KAKU_SAN_DEPLOYER);
  const refused = renderAdmin(wallet({ solanaAddress: OTHER }));
  assert.match(refused, /Create an index vault from a persisted definition/);
  assert.match(refused, /refused/);
  assert.match(refused, /does not open deposits/i);
  assert.doesNotMatch(refused, /AAPLx|2000 bps|Invest Sign/);
  const stub = renderAdmin(wallet({ mode: "stub", solanaAddress: KAKU_SAN_WSOL_MINT }));
  assert.match(stub, /live Solana wallet is required/i);
  const allowed = renderAdmin(wallet({ solanaAddress: KAKU_SAN_DEPLOYER }));
  assert.doesNotMatch(allowed, /refused/);
  assert.match(allowed, /Select a persisted index/);
});
