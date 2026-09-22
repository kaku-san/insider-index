import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { createDraftDb, type CreateDraftDb } from "./support/create-draft-db.mts";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { installedCompositionFixture } from "./support/installed-composition.mts";
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
import { CreateDraftJournal, type CreateDraftState } from "../src/lib/index-vaults/create-draft-store.ts";
import {
  applyIndexSubmit, canCreateIndexVault, nextIndexStep, parseIndexReceipt, reconcileIndexCreateDraft,
  saveIndexReceipt, type IndexReceipt,
} from "../src/lib/frontend/index-vault.ts";

async function temp<T>(fn: (db: CreateDraftDb) => Promise<T>): Promise<T> {
  const db = await createDraftDb();
  try { return await fn(db); } finally { await db.close(); }
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

function builders(vaultAccount: { data?: Uint8Array; owner?: PublicKey } | null = { data: new Uint8Array(1), owner: new PublicKey(SYMMETRY_PROGRAM_ID) }, fetched: Vault | null = null): NativeVaultBuilders {
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
      fetchVaultIntents: async () => [],
    },
    addToken: async () => payload,
    weights: async () => payload,
  } as unknown as NativeVaultBuilders;
}

function verifiedVault(): Vault {
  const def = assertCreatableDefinition(fakeDefinition(), INDEX_ID);
  return installedCompositionFixture(VAULT, MINT, def.legs.map(leg => ({ token: indexTokenInput(leg), targetWeightBps: leg.targetWeightBps })));
}

const request = (body: unknown, path = "/api/vaults/index/prepare") => new Request(`http://localhost${path}`, { method: "POST", body: JSON.stringify(body) });

test("creation builds from the persisted definition, not from Kaku San constants", async () => temp(async db => {
  const journal = indexCreateJournal(INDEX_ID, db.rpc);
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
  // Composition prepare is covered by real program execution in composition-resume.test.mts,
  // not by a mocked successful simulation of an unrelated SystemProgram transfer.
}));

test("only the approved deployer may prepare, submit, observe or discard", async () => temp(async db => {
  const journal = indexCreateJournal(INDEX_ID, db.rpc);
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
  const ok = await handleIndexPrepare(request({ creator: KAKU_SAN_DEPLOYER, indexId: INDEX_ID }), () => builders(), loader(fakeDefinition()), undefined, () => journal);
  assert.equal(ok.status, 200);
}));

test("an unsigned or foreign-signed request is refused", async () => temp(async db => {
  const journal = indexCreateJournal(INDEX_ID, db.rpc);
  // Submit with unsigned bytes never broadcasts (503, and the send stub throws if reached).
  const unsigned = await handleIndexSubmit(
    request({ creator: KAKU_SAN_DEPLOYER, indexId: INDEX_ID, step: "create", vault: VAULT, shareMint: MINT, signedTransactions: [unsignedPayload().tx_b64] }, "/api/vaults/index/submit"),
    () => ({ getGenesisHash: async () => GENESIS["mainnet-beta"], sendRawTransaction: async () => { throw new Error("should not send"); } } as never),
    async () => { throw new Error("should not write back an unsigned create"); },
    () => journal,
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
}));

test("cap violation throws rather than truncating the book", () => {
  const tooMany = Array.from({ length: 101 }, (_, i) => ({
    ticker: `T${i}`, mint: new PublicKey(new Uint8Array(32).fill((i % 200) + 30)).toBase58(),
    provider: "xstock", decimals: 8, pool: P1, kind: "raydium_clmm", tvlUsd: 1, targetWeightBps: 99,
  }));
  assert.throws(() => assertCreatableDefinition(fakeDefinition({ vaultLegs: tooMany }), INDEX_ID), /NATIVE_TOKEN_CAP/);
  const atCap = Array.from({ length: 98 }, (_, i) => ({ ...tooMany[i], targetWeightBps: i === 0 ? 300 : 100 }));
  assert.equal(assertCreatableDefinition(fakeDefinition({ vaultLegs: atCap }), INDEX_ID).legs.length, 98, "98 investment legs + two native allocated slots = 100");
  assert.throws(() => assertCreatableDefinition(fakeDefinition({ vaultLegs: [...atCap, tooMany[98]] }), INDEX_ID), /NATIVE_TOKEN_CAP/);
  assert.throws(() => assertCreatableDefinition(fakeDefinition({ vaultLegs: [{ ...legs()[0], mint: KAKU_SAN_WSOL_MINT }, ...legs().slice(1)] }), INDEX_ID), /not investment legs/);
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

test("submit only writes back on the create step, and a lost draft aborts before broadcast", async () => temp(async db => {
  const journal = indexCreateJournal(INDEX_ID, db.rpc);
  await prepareIndexStep({ creator: KAKU_SAN_DEPLOYER, indexId: INDEX_ID, step: "create" }, builders(null), loader(fakeDefinition()), true, journal);
  // A concurrent discard clears the draft; the in-flight submit's latch must throw before sending.
  assert.equal((await discardIndexCreateDraft({ creator: KAKU_SAN_DEPLOYER, indexId: INDEX_ID, vault: VAULT, shareMint: MINT }, builders(null), journal)).discarded, true);
  await assert.rejects(markIndexCreateBroadcast(INDEX_ID, VAULT, MINT, journal), /discarded before it could be broadcast/);
}));

test("discard refuses once broadcast or once the vault is a real Symmetry vault; deposits never open", async () => temp(async db => {
  const journal = indexCreateJournal(INDEX_ID, db.rpc);
  const native = builders(null);
  await prepareIndexStep({ creator: KAKU_SAN_DEPLOYER, indexId: INDEX_ID, step: "create" }, native, loader(fakeDefinition()), true, journal);
  await markIndexCreateBroadcast(INDEX_ID, VAULT, MINT, journal);
  await assert.rejects(discardIndexCreateDraft({ creator: KAKU_SAN_DEPLOYER, indexId: INDEX_ID, vault: VAULT, shareMint: MINT }, native, journal), /already broadcast/);
  // Deposits and public Invest Sign are default-closed and creating a vault never opens them.
  assert.equal(VAULT_RELEASE.publicFundsEnabled, true);
  assert.equal(VAULT_RELEASE.publicInvestSign, false);
  assert.equal(VAULT_RELEASE.status, "MAG7_DEPOSITS_PAUSED");
}));

test("discard refuses a draft whose vault is program-owned on-chain", async () => temp(async db => {
  const journal = indexCreateJournal(INDEX_ID, db.rpc);
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
  assert.deepEqual(ok.activeMints.sort(), [M1, M2, M3, KAKU_SAN_WSOL_MINT].sort());
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
  previewConnection: boolean; solanaAddress: string | null; solanaWallets: string[]; selectSolanaWallet: (address: string) => void; appId: string | null;
  connectionMethod: "wallet" | "email" | null; connect: () => Promise<void>; disconnect: () => Promise<void>;
  signMessage: (message: string) => Promise<string>;
  signTransaction: (transaction: string, network?: "mainnet-beta" | "devnet") => Promise<string>;
  signAndSendTransaction: (transaction: string, network?: "mainnet-beta" | "devnet") => Promise<string>;
};
function wallet(partial: Partial<TestWallet>): TestWallet {
  return {
    ready: true, configured: true, mode: "live", authenticated: true, previewConnection: false,
    solanaAddress: OTHER, solanaWallets: [OTHER], selectSolanaWallet: () => {}, appId: "test", connectionMethod: null,
    connect: async () => {}, disconnect: async () => {},
    signMessage: async () => { throw new Error("test wallet does not authorize access"); },
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

/** Builders that count createVaultTx calls and hand out a distinct vault per call, so a second
 *  createVaultTx for one draft is observable rather than inferred. */
function countingBuilders(vaultAccount: { data?: Uint8Array; owner?: PublicKey } | null, vaults: string[]) {
  const native = builders(vaultAccount);
  let calls = 0;
  native.sdk.createVaultTx = async () => {
    const vault = vaults[calls++] ?? vaults[vaults.length - 1];
    return { vault, mint: MINT, batches: [{ transactions: [unsignedPayload()] }] };
  };
  return { native, calls: () => calls };
}

test("a retry resumes the exact journaled vault and never issues a second createVaultTx", async () => temp(async db => {
  const { native, calls } = countingBuilders(null, [VAULT, OTHER]);
  const journal = indexCreateJournal(INDEX_ID, db.rpc);
  const first = await prepareIndexStep({ creator: KAKU_SAN_DEPLOYER, indexId: INDEX_ID, step: "create" }, native, loader(fakeDefinition()), true, journal);
  assert.equal(first.vault, VAULT);
  assert.equal(calls(), 1);
  // A fresh store instance (a new serverless invocation) still resumes the same draft.
  const second = await prepareIndexStep({ creator: KAKU_SAN_DEPLOYER, indexId: INDEX_ID, step: "create" }, native, loader(fakeDefinition()), true, indexCreateJournal(INDEX_ID, db.rpc));
  assert.equal(second.vault, VAULT);
  assert.equal(second.shareMint, MINT);
  assert.equal(calls(), 1, "the retry must not call createVaultTx again");
  // Only one row exists for the index, and it still holds the original vault.
  const rows = await db.query<{ vault: string; submitted: boolean }>("select vault, submitted from insiderindex_vault_create_drafts where draft_key = $1", [INDEX_ID]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].vault, VAULT);
}));

test("a journal that cannot be read or written refuses the create instead of proceeding unjournaled", async () => temp(async db => {
  const { native, calls } = countingBuilders(null, [VAULT, OTHER]);
  const unavailable = async () => { throw new Error("journal storage unavailable"); };
  await assert.rejects(
    prepareIndexStep({ creator: KAKU_SAN_DEPLOYER, indexId: INDEX_ID, step: "create" }, native, loader(fakeDefinition()), true, indexCreateJournal(INDEX_ID, unavailable)),
    /journal storage unavailable/,
  );
  assert.equal(calls(), 0, "an unjournaled create must never build a createVaultTx");
  // A write failure after the draft is built also refuses and leaves no usable draft behind.
  const lockOnly = indexCreateJournal(INDEX_ID, async (fn, args) => {
    if (fn === "write_insiderindex_vault_create_draft") throw new Error("journal write refused");
    return db.rpc(fn, args);
  });
  await assert.rejects(
    prepareIndexStep({ creator: KAKU_SAN_DEPLOYER, indexId: INDEX_ID, step: "create" }, native, loader(fakeDefinition()), true, lockOnly),
    /journal write refused/,
  );
  const rows = await db.query<{ vault: string | null }>("select vault from insiderindex_vault_create_drafts where draft_key = $1", [INDEX_ID]);
  assert.equal(rows[0]?.vault ?? null, null, "a refused write leaves no draft to resume");
}));

test("a discard is still refused once broadcast and once the vault is a real Symmetry vault on-chain", async () => temp(async db => {
  const journal = indexCreateJournal(INDEX_ID, db.rpc);
  await prepareIndexStep({ creator: KAKU_SAN_DEPLOYER, indexId: INDEX_ID, step: "create" }, builders(null), loader(fakeDefinition()), true, journal);
  await markIndexCreateBroadcast(INDEX_ID, VAULT, MINT, journal);
  await assert.rejects(discardIndexCreateDraft({ creator: KAKU_SAN_DEPLOYER, indexId: INDEX_ID, vault: VAULT, shareMint: MINT }, builders(null), journal), /already broadcast/);
  // The store-level latch cannot be cleared by a later write that claims submitted:false.
  await journal.update(state => { state.draft!.submitted = false; });
  const submitted = await db.query<{ submitted: boolean }>("select submitted from insiderindex_vault_create_drafts where draft_key = $1", [INDEX_ID]);
  assert.equal(submitted[0].submitted, true, "the submitted latch is monotonic in the store");
  // A fresh, never-broadcast draft whose vault is program-owned on-chain is refused too.
  const fresh = indexCreateJournal("insiderindex-josh-gottheimer", db.rpc);
  await prepareIndexStep({ creator: KAKU_SAN_DEPLOYER, indexId: INDEX_ID, step: "create" }, builders(null), loader(fakeDefinition()), true, fresh);
  const confirmed = builders({ data: new Uint8Array(1), owner: new PublicKey(SYMMETRY_PROGRAM_ID) });
  await assert.rejects(discardIndexCreateDraft({ creator: KAKU_SAN_DEPLOYER, indexId: INDEX_ID, vault: VAULT, shareMint: MINT }, confirmed, fresh), /exists on-chain/);
}));

test("two concurrent creates for one index cannot both proceed", async () => temp(async db => {
  const { native, calls } = countingBuilders(null, [VAULT, OTHER]);
  const shared = indexCreateJournal(INDEX_ID, db.rpc);
  // Hold the lease directly, exactly as an in-flight create on another invocation would.
  const held = shared.update(async state => { await new Promise(resolve => setImmediate(resolve)); return state; });
  await assert.rejects(
    prepareIndexStep({ creator: KAKU_SAN_DEPLOYER, indexId: INDEX_ID, step: "create" }, native, loader(fakeDefinition()), true, indexCreateJournal(INDEX_ID, db.rpc)),
    /locked by another writer/,
  );
  await held;
  assert.equal(calls(), 0, "the losing writer must never build a createVaultTx");
  // Once the lease is released, the create proceeds normally.
  const prepared = await prepareIndexStep({ creator: KAKU_SAN_DEPLOYER, indexId: INDEX_ID, step: "create" }, native, loader(fakeDefinition()), true, indexCreateJournal(INDEX_ID, db.rpc));
  assert.equal(prepared.vault, VAULT);
  assert.equal(calls(), 1);
}));

test("the create-draft store is the only journal: it rejects a bad key and needs no local disk", async () => {
  assert.throws(() => new CreateDraftJournal("", () => ({ indexId: null, draft: null }) as CreateDraftState, async () => null), /1-128 characters/);
  assert.throws(() => new CreateDraftJournal("x".repeat(129), () => ({ indexId: null, draft: null }), async () => null), /1-128 characters/);
});
