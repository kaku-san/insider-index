import test from "node:test";
import { installedCompositionFixture } from "./support/installed-composition.mts";
import { compositionVm, snapshot } from "./support/composition-vm.mts";
import assert from "node:assert/strict";
import { register } from "node:module";
import { createDraftDb, type CreateDraftDb } from "./support/create-draft-db.mts";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { OracleType } from "@symmetry-hq/sdk/dist/layouts/oracle.js";
import type { Vault } from "@symmetry-hq/sdk";
import { DEVNET_DEPOSIT_SIGNING_ENABLED } from "../src/lib/index-vaults/devnet-contract.ts";
import {
  KAKU_SAN, KAKU_SAN_ASSETS, KAKU_SAN_DEFAULT_SLOTS, KAKU_SAN_DEPLOYER, KAKU_SAN_RAYDIUM_POOLS,
  KAKU_SAN_USDC_MINT, KAKU_SAN_WSOL_MINT, assertKakuSanDeployer,
} from "../src/lib/index-vaults/kaku-san.ts";
import {
  assertKakuSanComposition, assertSignedBy, assertSignedByDeployer, confirmWalletTransaction,
  discardKakuSanCreateDraft, handleKakuSanDiscard, handleKakuSanObserve, handleKakuSanPrepare,
  handleKakuSanSubmit, kakuSanConnection, kakuSanCreateJournal, kakuSanDeactivateInput, kakuSanOracleInput,
  kakuSanTokenInput, markKakuSanCreateBroadcast, observeKakuSanVault, parseKakuSanDiscardRequest,
  parseKakuSanObserveRequest, parseKakuSanPrepareRequest, parseKakuSanSubmitRequest, payloadTransactions,
  prepareKakuSanStep,
} from "../src/lib/index-vaults/kaku-san-create.ts";
import { assertNoPythEnvironment, assertRaydiumOnlyToken } from "../src/lib/index-vaults/raydium-oracles.ts";
import { NativeVaultBuilders, SYMMETRY_PROGRAM_ID } from "../src/lib/index-vaults/symmetry-adapter.ts";
import {
  applyKakuSanSubmit, canCreateKakuSan, clearKakuSanReceipt, loadKakuSanReceipt, mergeKakuSanObservation,
  nextKakuSanStep, parseKakuSanReceipt, reconcileKakuSanCreateDraft, saveKakuSanReceipt, signPreparedKakuSan,
  type KakuSanReceipt,
} from "../src/lib/frontend/kaku-san.ts";
import { POST as prepareRoute } from "../src/app/api/vaults/kaku-san/prepare/route.ts";
import { POST as submitRoute } from "../src/app/api/vaults/kaku-san/submit/route.ts";
import { POST as observeRoute } from "../src/app/api/vaults/kaku-san/observe/route.ts";
import { POST as discardRoute } from "../src/app/api/vaults/kaku-san/discard/route.ts";
import { STUB_WALLET_ADDRESS } from "../src/lib/wallet.ts";
import robots from "../src/app/robots.ts";

async function temp<T>(fn: (db: CreateDraftDb) => Promise<T>): Promise<T> {
  const db = await createDraftDb();
  try { return await fn(db); } finally { await db.close(); }
}

register("./support/ui-loader.mjs", import.meta.url);
const { KakuAdmin } = await import("../src/components/kaku-admin.tsx");
const { PrivySolanaContext } = await import("../src/components/providers/privy-provider.tsx");
const { IndexHome } = await import("../src/components/index-home.tsx");
const { metadata: kakuAdminMetadata } = await import("../src/app/kaku-admin/page.tsx");
type TestWallet = {
  ready: boolean; configured: boolean; mode: "live" | "stub" | "unavailable"; authenticated: boolean;
  previewConnection: boolean; solanaAddress: string | null; appId: string | null;
  connectionMethod: "wallet" | "email" | null; connect: () => Promise<void>; disconnect: () => Promise<void>;
  signTransaction: (transaction: string, network?: "mainnet-beta" | "devnet") => Promise<string>;
  signAndSendTransaction: (transaction: string, network?: "mainnet-beta" | "devnet") => Promise<string>;
};

const VAULT = new PublicKey(new Uint8Array(32).fill(2)).toBase58();
const MINT = new PublicKey(new Uint8Array(32).fill(3)).toBase58();
const OTHER = new PublicKey(new Uint8Array(32).fill(9)).toBase58();

function installedVault(overrides: Partial<{ pyth: boolean; wsolInactive: boolean; missingStock: boolean; unresolvedPool: boolean }> = {}): Vault {
  const v = installedCompositionFixture(VAULT, MINT, KAKU_SAN_ASSETS.map(asset => ({ token: kakuSanTokenInput(asset), targetWeightBps: asset.targetWeightBps })));
  if (overrides.pyth) v.composition[0].oracleAggregator.oracles[0].oracleSettings.oracleType = OracleType.Pyth;
  if (overrides.wsolInactive) v.composition[0].active = 0;
  if (overrides.missingStock) { v.composition.splice(2, 1); v.numTokens--; }
  if (overrides.unresolvedPool) v.composition[2].oracleAggregator.oracles[0].accountsToLoadLutIndices[0] = 99;
  return v;
}

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
      fetchVault: async () => fetched ?? installedVault(),
      fetchVaultIntents: async () => [],
    },
    addToken: async () => payload,
    weights: async () => payload,
  } as unknown as NativeVaultBuilders;
}

const request = (body: unknown, path = "/api/vaults/kaku-san/prepare") => new Request(`http://localhost${path}`, { method: "POST", body: JSON.stringify(body) });

test("Kaku San basket is five equal 2000 bps Raydium CLMM legs on the documented pools", () => {
  assert.equal(KAKU_SAN.network, "mainnet-beta");
  assert.equal(KAKU_SAN.name, "Kaku San Index");
  assert.equal(KAKU_SAN.symbol, "KAKU");
  assert.equal(KAKU_SAN.label, "Execution Test — not politician holdings");
  assert.equal(KAKU_SAN.hostEntryFeeBps, 25);
  assert.equal(KAKU_SAN.hostExitFeeBps, 0);
  assert.equal(KAKU_SAN_ASSETS.length, 5);
  assert.equal(KAKU_SAN_ASSETS.reduce((sum, asset) => sum + asset.targetWeightBps, 0), 10_000);
  for (const asset of KAKU_SAN_ASSETS) {
    assert.equal(asset.kind, "raydium_clmm");
    assert.equal(asset.targetWeightBps, 2000);
    assert.doesNotThrow(() => kakuSanTokenInput(asset));
  }
  assert.deepEqual(KAKU_SAN_ASSETS.map(a => a.ticker), ["AAPLx", "NVDAx", "MSFTx", "AMZNx", "GOOGLx"]);
  for (const binding of KAKU_SAN_RAYDIUM_POOLS) assert.equal(binding.kind, "raydium_clmm");
});

test("Kaku San token oracles reject Pyth and every non-CLMM type, and refuse invented pools", () => {
  const token = kakuSanTokenInput(KAKU_SAN_ASSETS[0]);
  token.oracles[0].oracle_type = "pyth";
  assert.throws(() => assertRaydiumOnlyToken(token, KAKU_SAN_RAYDIUM_POOLS), /ORACLE_TYPE_FORBIDDEN/);
  const cpmm = kakuSanTokenInput(KAKU_SAN_ASSETS[0]);
  cpmm.oracles[0].oracle_type = "raydium_cpmm";
  assert.throws(() => assertRaydiumOnlyToken(cpmm, KAKU_SAN_RAYDIUM_POOLS), /ORACLE_KIND_MISMATCH/);
  const wrong = kakuSanTokenInput(KAKU_SAN_ASSETS[0]);
  wrong.oracles[0].account = KAKU_SAN_ASSETS[1].pool;
  assert.throws(() => assertRaydiumOnlyToken(wrong, KAKU_SAN_RAYDIUM_POOLS), /RAYDIUM_POOL_MISMATCH/);
  const oracle = kakuSanOracleInput(KAKU_SAN_ASSETS[0]);
  assert.equal(oracle.oracle_type, "raydium_clmm");
  assert.equal(oracle.account, KAKU_SAN_ASSETS[0].pool);
});

test("only the approved deployer may prepare or submit; extra fields and keypair paths are rejected", () => {
  assert.equal(assertKakuSanDeployer(KAKU_SAN_DEPLOYER), KAKU_SAN_DEPLOYER);
  assert.throws(() => assertKakuSanDeployer(OTHER), /approved deployer/);
  assert.deepEqual(parseKakuSanPrepareRequest({ creator: KAKU_SAN_DEPLOYER }), { creator: KAKU_SAN_DEPLOYER, step: "create" });
  for (const body of [
    { creator: OTHER }, { creator: KAKU_SAN_DEPLOYER, keypair: "/tmp/id.json" }, { creator: KAKU_SAN_DEPLOYER, network: "devnet" },
    { creator: KAKU_SAN_DEPLOYER, execute: true }, { creator: KAKU_SAN_DEPLOYER, step: "redeem" }, {},
  ]) assert.throws(() => parseKakuSanPrepareRequest(body));
  assert.throws(() => parseKakuSanPrepareRequest({ creator: KAKU_SAN_DEPLOYER, step: "add-token" }), /vault and share mint/i);
  assert.throws(() => parseKakuSanPrepareRequest({ creator: KAKU_SAN_DEPLOYER, step: "deactivate-default", vault: VAULT, shareMint: MINT, mint: KAKU_SAN_ASSETS[0].mint }), /default slot/);
  assert.deepEqual(
    parseKakuSanPrepareRequest({ creator: KAKU_SAN_DEPLOYER, step: "deactivate-default", vault: VAULT, shareMint: MINT, mint: KAKU_SAN_WSOL_MINT }),
    { creator: KAKU_SAN_DEPLOYER, step: "deactivate-default", vault: VAULT, shareMint: MINT, mint: KAKU_SAN_WSOL_MINT },
  );
  assert.throws(() => parseKakuSanSubmitRequest({ creator: KAKU_SAN_DEPLOYER, step: "create", vault: VAULT, shareMint: MINT, signedTransactions: [] }));
  assert.throws(() => parseKakuSanObserveRequest({ creator: OTHER, vault: VAULT, shareMint: MINT }));
});

test("prepare RPC forbids sends, airdrops and devnet; HERMES/PYTH env fails closed", () => {
  assert.throws(() => kakuSanConnection(false, "https://api.devnet.solana.com"), /Mainnet RPC only/);
  const dry = kakuSanConnection(false, "https://api.mainnet-beta.solana.com");
  assert.rejects(() => dry.sendRawTransaction(Buffer.alloc(8)), /not permitted in prepare/);
  assert.rejects(() => dry.requestAirdrop(new PublicKey(KAKU_SAN_DEPLOYER), 1), /not permitted/);
  assert.rejects(() => kakuSanConnection(true, "https://api.mainnet-beta.solana.com").requestAirdrop(new PublicKey(KAKU_SAN_DEPLOYER), 1), /not permitted/);
  assert.throws(() => assertNoPythEnvironment({ HERMES_URL: "https://hermes.example" } as unknown as NodeJS.ProcessEnv), /PYTH_ENV_FORBIDDEN/);
});

test("prepare returns unsigned create transactions and the public vault + share mint", async () => temp(async db => {
  const journal = kakuSanCreateJournal(db.rpc);
  const prepared = await prepareKakuSanStep({ creator: KAKU_SAN_DEPLOYER, step: "create" }, builders(), true, journal);
  assert.equal(prepared.vault, VAULT);
  assert.equal(prepared.shareMint, MINT);
  assert.equal(prepared.step, "create");
  assert.equal(prepared.transactions.length, 1);
  assert.equal(prepared.transactions[0].payer, KAKU_SAN_DEPLOYER);
  assert.equal(prepared.label, KAKU_SAN.label);
  const tx = VersionedTransaction.deserialize(Buffer.from(prepared.transactions[0].txBase64, "base64"));
  assert.ok(tx.signatures[0].every(byte => byte === 0));
  assert.throws(() => payloadTransactions({ batches: [{ transactions: [{ ...unsignedPayload(), payer: OTHER }] }] }, KAKU_SAN_DEPLOYER));
}));

test("create draft is journaled: a retry resumes the same vault with a refreshed blockhash and never calls createVaultTx twice", async () => temp(async db => {
  const journal = kakuSanCreateJournal(db.rpc);
  const native = builders();
  let createCalls = 0;
  const refreshedBlockhash = new PublicKey(new Uint8Array(32).fill(7)).toBase58();
  native.sdk.createVaultTx = async () => { createCalls++; return { vault: VAULT, mint: MINT, batches: [{ transactions: [unsignedPayload()] }] }; };
  native.connection.getLatestBlockhash = async () => ({ blockhash: refreshedBlockhash, lastValidBlockHeight: 1 });

  const first = await prepareKakuSanStep({ creator: KAKU_SAN_DEPLOYER, step: "create" }, native, true, journal);
  assert.equal(createCalls, 1);
  assert.equal(first.vault, VAULT);
  assert.equal(first.shareMint, MINT);

  const second = await prepareKakuSanStep({ creator: KAKU_SAN_DEPLOYER, step: "create" }, native, true, journal);
  assert.equal(createCalls, 1, "resume must not call createVaultTx a second time");
  assert.equal(second.vault, VAULT);
  assert.equal(second.shareMint, MINT);
  const firstTx = VersionedTransaction.deserialize(Buffer.from(first.transactions[0].txBase64, "base64"));
  const secondTx = VersionedTransaction.deserialize(Buffer.from(second.transactions[0].txBase64, "base64"));
  assert.notEqual(firstTx.message.recentBlockhash, secondTx.message.recentBlockhash);
  assert.equal(secondTx.message.staticAccountKeys[0]?.toBase58(), KAKU_SAN_DEPLOYER);
}));

test("discard clears an unconfirmed draft and permits exactly one new createVaultTx; a draft with an on-chain vault refuses discard", async () => temp(async db => {
  const journal = kakuSanCreateJournal(db.rpc);
  const native = builders(null);
  let createCalls = 0;
  native.sdk.createVaultTx = async () => { createCalls++; return { vault: VAULT, mint: MINT, batches: [{ transactions: [unsignedPayload()] }] }; };

  await prepareKakuSanStep({ creator: KAKU_SAN_DEPLOYER, step: "create" }, native, true, journal);
  assert.equal(createCalls, 1);

  const mismatched = { creator: KAKU_SAN_DEPLOYER, vault: VAULT, shareMint: OTHER };
  await assert.rejects(discardKakuSanCreateDraft(mismatched, native, journal), /resume it instead/);

  const discardInput = { creator: KAKU_SAN_DEPLOYER, vault: VAULT, shareMint: MINT };
  assert.equal((await discardKakuSanCreateDraft(discardInput, native, journal)).discarded, true);

  await prepareKakuSanStep({ creator: KAKU_SAN_DEPLOYER, step: "create" }, native, true, journal);
  assert.equal(createCalls, 2, "discard must allow exactly one fresh createVaultTx");

  const confirmed = builders({ data: new Uint8Array(1), owner: new PublicKey(SYMMETRY_PROGRAM_ID) });
  await assert.rejects(discardKakuSanCreateDraft(discardInput, confirmed, journal), /exists on-chain/);
}));

test("discard is not fooled by a stray-funded address at the derived vault PDA that is not a real Symmetry vault", async () => temp(async db => {
  const journal = kakuSanCreateJournal(db.rpc);
  const native = builders(null);
  await prepareKakuSanStep({ creator: KAKU_SAN_DEPLOYER, step: "create" }, native, true, journal);

  const discardInput = { creator: KAKU_SAN_DEPLOYER, vault: VAULT, shareMint: MINT };
  // An unrelated System-Program-owned address that merely received a stray balance at the derived vault
  // PDA must never be mistaken for a created Symmetry vault.
  const strayFunded = builders({ data: new Uint8Array(0), owner: SystemProgram.programId });
  assert.equal((await discardKakuSanCreateDraft(discardInput, strayFunded, journal)).discarded, true);
}));

test("discard refuses once the create has been broadcast, even before any on-chain confirmation is observable", async () => temp(async db => {
  const journal = kakuSanCreateJournal(db.rpc);
  const native = builders(null);
  let createCalls = 0;
  native.sdk.createVaultTx = async () => { createCalls++; return { vault: VAULT, mint: MINT, batches: [{ transactions: [unsignedPayload()] }] }; };
  const prepared = await prepareKakuSanStep({ creator: KAKU_SAN_DEPLOYER, step: "create" }, native, true, journal);
  assert.equal(createCalls, 1);

  // Reproduces the exact race a lost submit response leaves behind: submitKakuSanStep latches the draft as
  // broadcast (markKakuSanCreateBroadcast) strictly before it ever calls sendRawTransaction, so this state
  // is durable even if the client never sees a confirmation and the vault is not yet observable on-chain
  // (native.connection.getAccountInfo below still returns null, matching the un-landed transaction).
  await markKakuSanCreateBroadcast(prepared.vault!, prepared.shareMint!, journal);

  const discardInput = { creator: KAKU_SAN_DEPLOYER, vault: prepared.vault!, shareMint: prepared.shareMint! };
  await assert.rejects(discardKakuSanCreateDraft(discardInput, native, journal), /already broadcast/);

  // Resuming must still resolve to the same journaled vault/mint; it must never call createVaultTx again.
  const resumed = await prepareKakuSanStep({ creator: KAKU_SAN_DEPLOYER, step: "create" }, native, true, journal);
  assert.equal(resumed.vault, prepared.vault);
  assert.equal(resumed.shareMint, prepared.shareMint);
  assert.equal(createCalls, 1, "a broadcast draft must resume, never re-derive via createVaultTx");
}));

test("a submit racing a concurrent discard must abort before broadcasting, never re-derive a second vault", async () => temp(async db => {
  const journal = kakuSanCreateJournal(db.rpc);
  const native = builders(null);
  let createCalls = 0;
  native.sdk.createVaultTx = async () => { createCalls++; return { vault: VAULT, mint: MINT, batches: [{ transactions: [unsignedPayload()] }] }; };
  const prepared = await prepareKakuSanStep({ creator: KAKU_SAN_DEPLOYER, step: "create" }, native, true, journal);
  assert.equal(createCalls, 1);

  // A concurrent discard wins the race while a submit for the same draft is still in flight (e.g. a
  // reloaded tab discards a draft the original request is about to broadcast).
  const discardInput = { creator: KAKU_SAN_DEPLOYER, vault: prepared.vault!, shareMint: prepared.shareMint! };
  assert.equal((await discardKakuSanCreateDraft(discardInput, native, journal)).discarded, true);

  // The in-flight submit's latch call must now fail loudly, aborting submitKakuSanStep before it ever
  // calls sendRawTransaction, instead of silently no-opping and letting the transaction broadcast.
  await assert.rejects(markKakuSanCreateBroadcast(prepared.vault!, prepared.shareMint!, journal), /discarded before it could be broadcast/);

  await prepareKakuSanStep({ creator: KAKU_SAN_DEPLOYER, step: "create" }, native, true, journal);
  assert.equal(createCalls, 2, "discard must allow exactly one fresh createVaultTx, not zero and not more");
}));

test("a local receipt for a since-discarded draft is reconciled to the server's current draft, never stuck", async () => temp(async db => {
  const journal = kakuSanCreateJournal(db.rpc);
  const native = builders(null);
  const vaults = [VAULT, OTHER];
  let createCalls = 0;
  native.sdk.createVaultTx = async () => ({ vault: vaults[createCalls++], mint: MINT, batches: [{ transactions: [unsignedPayload()] }] });

  const memory = new Map<string, string>();
  globalThis.localStorage = {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => { memory.set(key, value); },
    removeItem: (key: string) => { memory.delete(key); },
  } as unknown as Storage;
  try {
    const first = await prepareKakuSanStep({ creator: KAKU_SAN_DEPLOYER, step: "create" }, native, true, journal);
    const staleReceipt = saveKakuSanReceipt({
      vault: first.vault!, shareMint: first.shareMint!, signatures: [], slot: null,
      created: false, deactivated: [], added: [], weightsSet: false, verified: false,
    });

    // Another tab discards the never-broadcast draft, then a fresh prepare (e.g. the same operator resuming)
    // journals a genuinely new draft. The server now tracks OTHER, not VAULT.
    const discardInput = { creator: KAKU_SAN_DEPLOYER, vault: first.vault!, shareMint: first.shareMint! };
    assert.equal((await discardKakuSanCreateDraft(discardInput, native, journal)).discarded, true);
    const second = await prepareKakuSanStep({ creator: KAKU_SAN_DEPLOYER, step: "create" }, native, true, journal);
    assert.equal(createCalls, 2);
    assert.notEqual(second.vault, staleReceipt.vault);

    // The stale local receipt must be reconciled to the server's current draft, not dead-end the operator.
    const reconciled = reconcileKakuSanCreateDraft(staleReceipt, second);
    assert.equal(reconciled.vault, second.vault);
    assert.equal(reconciled.created, false);
    assert.equal(loadKakuSanReceipt()?.vault, second.vault, "the local receipt must follow the server, not the discarded draft");

    // A matching draft is returned unchanged (no unnecessary re-save of in-progress steps).
    const unchanged = reconcileKakuSanCreateDraft(reconciled, second);
    assert.equal(unchanged, reconciled);

    assert.throws(() => reconcileKakuSanCreateDraft(null, { vault: null, shareMint: null }), /vault and share mint/);
  } finally {
    clearKakuSanReceipt();
  }
}));

test("HTTP discard is no-store and refuses a non-deployer", async () => temp(async db => {
  const journal = kakuSanCreateJournal(db.rpc);
  await prepareKakuSanStep({ creator: KAKU_SAN_DEPLOYER, step: "create" }, builders(null), true, journal);
  const denied = await handleKakuSanDiscard(request({ creator: OTHER, vault: VAULT, shareMint: MINT, signedTransaction: unsignedPayload(OTHER).tx_b64 }, "/api/vaults/kaku-san/discard"), () => builders(null), undefined, journal);
  assert.equal(denied.status, 400);
  assert.equal(denied.headers.get("Cache-Control"), "no-store");
  assert.equal((await discardRoute(request({ creator: OTHER, vault: VAULT, shareMint: MINT }, "/api/vaults/kaku-san/discard"))).status, 400);
}));

test("discard requires the deployer's Ed25519 signature: unsigned or foreign-signed authorization is refused and leaves the draft resumable", async () => temp(async db => {
  const journal = kakuSanCreateJournal(db.rpc);
  await prepareKakuSanStep({ creator: KAKU_SAN_DEPLOYER, step: "create" }, builders(null), true, journal);

  // An unsigned authorization (deployer payer, but no signature) cannot clear the draft.
  assert.throws(() => parseKakuSanDiscardRequest({ creator: KAKU_SAN_DEPLOYER, vault: VAULT, shareMint: MINT, signedTransaction: unsignedPayload().tx_b64 }), /unsigned/);
  // A transaction signed by a wallet that is not the deployer cannot authorize a discard.
  const kp = Keypair.generate();
  const foreign = new VersionedTransaction(new TransactionMessage({
    payerKey: kp.publicKey, recentBlockhash: PublicKey.default.toBase58(),
    instructions: [SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: kp.publicKey, lamports: 1 })],
  }).compileToV0Message());
  foreign.sign([kp]);
  const foreignB64 = Buffer.from(foreign.serialize()).toString("base64");
  assert.throws(() => parseKakuSanDiscardRequest({ creator: KAKU_SAN_DEPLOYER, vault: VAULT, shareMint: MINT, signedTransaction: foreignB64 }), /approved deployer/);

  // Both refusals surface as HTTP 400s and never mutate the journal.
  const missing = await handleKakuSanDiscard(request({ creator: KAKU_SAN_DEPLOYER, vault: VAULT, shareMint: MINT }, "/api/vaults/kaku-san/discard"), () => builders(null), undefined, journal);
  assert.equal(missing.status, 400);
  const foreignHttp = await handleKakuSanDiscard(request({ creator: KAKU_SAN_DEPLOYER, vault: VAULT, shareMint: MINT, signedTransaction: foreignB64 }, "/api/vaults/kaku-san/discard"), () => builders(null), undefined, journal);
  assert.equal(foreignHttp.status, 400);

  // The never-broadcast draft survived both rejected discards: it resumes, never re-derives a new vault.
  const resumed = await prepareKakuSanStep({ creator: KAKU_SAN_DEPLOYER, step: "create" }, builders(null), true, journal);
  assert.equal(resumed.vault, VAULT);
  assert.equal(resumed.shareMint, MINT);
}));

test("signed-by helper accepts a matching keypair and deployer submit refuses unsigned or foreign payers", () => {
  const kp = Keypair.generate();
  const message = new TransactionMessage({
    payerKey: kp.publicKey, recentBlockhash: PublicKey.default.toBase58(),
    instructions: [SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: kp.publicKey, lamports: 1 })],
  }).compileToV0Message();
  const tx = new VersionedTransaction(message);
  assert.throws(() => assertSignedBy(Buffer.from(tx.serialize()).toString("base64"), kp.publicKey.toBase58()), /unsigned/);
  tx.sign([kp]);
  assert.doesNotThrow(() => assertSignedBy(Buffer.from(tx.serialize()).toString("base64"), kp.publicKey.toBase58()));
  assert.throws(() => assertSignedByDeployer(Buffer.from(tx.serialize()).toString("base64")), /approved deployer/);
  assert.throws(() => assertSignedByDeployer(unsignedPayload().tx_b64), /unsigned/);
});

test("HTTP prepare is no-store and refuses a non-deployer; submit refuses unsigned bytes", async () => temp(async db => {
  const journal = kakuSanCreateJournal(db.rpc);
  const ok = await handleKakuSanPrepare(request({ creator: KAKU_SAN_DEPLOYER }), () => builders(), undefined, journal);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("Cache-Control"), "no-store");
  const body = await ok.json();
  assert.equal(body.vault, VAULT);
  assert.equal(body.shareMint, MINT);
  const denied = await handleKakuSanPrepare(request({ creator: OTHER }), () => builders(), undefined, journal);
  assert.equal(denied.status, 400);
  const unsigned = await handleKakuSanSubmit(request({
    creator: KAKU_SAN_DEPLOYER, step: "create", vault: VAULT, shareMint: MINT, signedTransactions: [unsignedPayload().tx_b64],
  }, "/api/vaults/kaku-san/submit"), () => ({ sendRawTransaction: async () => { throw new Error("should not send"); } } as never));
  assert.equal(unsigned.status, 503);
  assert.equal((await prepareRoute(request({ creator: OTHER }))).status, 400);
  assert.equal((await submitRoute(request({ creator: OTHER, step: "create", vault: VAULT, shareMint: MINT, signedTransactions: ["AA"] }, "/api/vaults/kaku-san/submit"))).status, 400);
}));

test("live deployer may sign; stub, preview and any other wallet are refused. Public Invest Sign stays off", async () => temp(async db => {
  const journal = kakuSanCreateJournal(db.rpc);
  assert.equal(canCreateKakuSan({ mode: "live", authenticated: true, solanaAddress: KAKU_SAN_DEPLOYER }), true);
  assert.equal(canCreateKakuSan({ mode: "stub", authenticated: true, solanaAddress: STUB_WALLET_ADDRESS }), false);
  assert.equal(canCreateKakuSan({ mode: "live", authenticated: true, solanaAddress: OTHER }), false);
  assert.equal(DEVNET_DEPOSIT_SIGNING_ENABLED, false);
  const prepared = await prepareKakuSanStep({ creator: KAKU_SAN_DEPLOYER, step: "create" }, builders(), false, journal);
  await assert.rejects(signPreparedKakuSan(prepared, {
    mode: "stub", authenticated: true, solanaAddress: STUB_WALLET_ADDRESS,
    signTransaction: async () => { throw new Error("stub must not sign Kaku San"); },
  }, () => true), /approved deployer/);
}));

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
  return renderToStaticMarkup(createElement(PrivySolanaContext.Provider, { value }, createElement(KakuAdmin) as ReactNode));
}

test("kaku-admin labels the execution test, refuses any other connected wallet, and does not enable create", () => {
  const refused = renderAdmin(wallet({ solanaAddress: OTHER }));
  assert.match(refused, /Execution test/);
  assert.match(refused, /not a politician filing/i);
  assert.match(refused, /refused/);
  assert.match(refused, /Create Kaku San vault/);
  assert.match(refused, /disabled=""/);
  assert.match(refused, /25 bps in/);
  assert.match(refused, /Estimated shares are not guaranteed/);
  assert.match(refused, /does not redeem or pay USDC out/);
  assert.doesNotMatch(refused, /Nancy|Pelosi|Invest Sign/);
  const stub = renderAdmin(wallet({ mode: "stub", solanaAddress: STUB_WALLET_ADDRESS }));
  assert.match(stub, /live Solana wallet is required/i);
  const allowed = renderAdmin(wallet({ solanaAddress: KAKU_SAN_DEPLOYER }));
  assert.doesNotMatch(allowed, /refused/);
  assert.match(allowed, /AAPLx/);
  assert.match(allowed, /2000 bps/);
});

test("kaku-admin is unlisted: robots disallow it, the page is noindex, and home has no create link", () => {
  const rules = robots().rules as { disallow: string[] };
  assert.deepEqual(rules.disallow, ["/kaku-admin"]);
  assert.equal((kakuAdminMetadata.robots as { index: boolean }).index, false);
  const home = renderToStaticMarkup(createElement(IndexHome, { initialData: { people: [], total: 0, partial: false, savedAt: null, storage: "supabase" } }));
  assert.doesNotMatch(home, /kaku-admin/);
  assert.doesNotMatch(home, /Create Kaku San/);
});

test("default configuration uses valid Raydium inputs and the shared native atomic path", async () => {
  const token = kakuSanDeactivateInput(KAKU_SAN_WSOL_MINT);
  assert.equal(token.active, true);
  assert.equal(token.oracles[0].weight_bps, 10000);
  assert.equal(kakuSanDeactivateInput(KAKU_SAN_USDC_MINT).token_mint, KAKU_SAN_USDC_MINT);
  assert.throws(() => kakuSanDeactivateInput(KAKU_SAN_ASSETS[0].mint), /creation-time WSOL\/USDC/);
  const vm = compositionVm();
  const prepared = await prepareKakuSanStep({
    creator: snapshot.creator, step: "deactivate-default", vault: snapshot.vault, shareMint: snapshot.shareMint, mint: KAKU_SAN_WSOL_MINT,
  }, vm.native);
  vm.apply(prepared.transactions[0].txBase64);
  assert.equal(prepared.step, "deactivate-default");
  assert.equal(prepared.mint, KAKU_SAN_WSOL_MINT);
  assert.equal(prepared.vault, snapshot.vault);
});

test("installed composition requires 5 xStocks plus exact zero-target native support and no Pyth", () => {
  assert.deepEqual(assertKakuSanComposition(installedVault()).activeMints, [KAKU_SAN_WSOL_MINT, ...KAKU_SAN_ASSETS.map(asset => asset.mint)]);
  assert.throws(() => assertKakuSanComposition(installedVault({ pyth: true })), /ORACLE_TYPE_FORBIDDEN/);
  assert.throws(() => assertKakuSanComposition(installedVault({ wsolInactive: true })), /COMPOSITION_TOKEN/);
  assert.throws(() => assertKakuSanComposition(installedVault({ missingStock: true })), /COMPOSITION_MINTS/);
});

test("installed composition fails closed when a leg's Raydium pool cannot be resolved from the vault's lookup table", () => {
  assert.throws(
    () => assertKakuSanComposition(installedVault({ unresolvedPool: true })),
    /ORACLE_ACCOUNT_MISSING/,
  );
});

test("observe reports missing accounts without fabricating a vault, and HTTP observe refuses non-deployers", async () => {
  const missing = await observeKakuSanVault({ vault: VAULT, shareMint: MINT }, builders(null));
  assert.equal(missing.exists, false);
  assert.equal(missing.verified, false);
  const ok = await observeKakuSanVault({ vault: VAULT, shareMint: MINT }, builders());
  assert.equal(ok.exists, true);
  assert.equal(ok.verified, true);
  assert.equal(ok.pythRemaining, false);
  const denied = await handleKakuSanObserve(request({ creator: OTHER, vault: VAULT, shareMint: MINT }, "/api/vaults/kaku-san/observe"));
  assert.equal(denied.status, 400);
  assert.equal((await observeRoute(request({ creator: OTHER, vault: VAULT, shareMint: MINT }, "/api/vaults/kaku-san/observe"))).status, 400);
});

test("confirm uses signature status, not a freshly fetched blockhash", async () => {
  const seen: unknown[] = [];
  const slot = await confirmWalletTransaction({
    confirmTransaction: async (arg: unknown) => { seen.push(arg); return { value: { err: null }, context: { slot: 99 } }; },
  } as never, "5" + "x".repeat(86));
  assert.equal(slot, 99);
  assert.equal(seen.length, 1);
  assert.equal(typeof seen[0], "string");
});

test("receipt resume never returns create after the first vault, and a different vault is refused", () => {
  const memory = new Map<string, string>();
  globalThis.localStorage = {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => { memory.set(key, value); },
    removeItem: (key: string) => { memory.delete(key); },
  } as unknown as Storage;
  assert.equal(nextKakuSanStep(null).step, "create");
  const draft = saveKakuSanReceipt({
    vault: VAULT, shareMint: MINT, signatures: [], slot: null, created: false, deactivated: [], added: [], weightsSet: false, verified: false,
  });
  assert.equal(nextKakuSanStep(draft).step, "create");
  assert.match(renderAdmin(wallet({ solanaAddress: KAKU_SAN_DEPLOYER })), /Discard draft/);
  const created = applyKakuSanSubmit(draft, { step: "create", vault: VAULT, shareMint: MINT, signatures: ["sig"], slot: 1 });
  assert.equal(created.created, true);
  assert.doesNotMatch(renderAdmin(wallet({ solanaAddress: KAKU_SAN_DEPLOYER })), /Discard draft/);
  clearKakuSanReceipt();
  assert.equal(loadKakuSanReceipt(), null);
  saveKakuSanReceipt(created);
  assert.equal(nextKakuSanStep(created).step, "deactivate-default");
  assert.equal((nextKakuSanStep(created) as { mint?: string }).mint, KAKU_SAN_WSOL_MINT);
  assert.throws(() => applyKakuSanSubmit(created, { step: "create", vault: OTHER, shareMint: MINT, signatures: ["nope"], slot: 2 }), /second vault/);
  let current: KakuSanReceipt = created;
  for (const slot of KAKU_SAN_DEFAULT_SLOTS) current = applyKakuSanSubmit(current, { step: "deactivate-default", vault: VAULT, shareMint: MINT, signatures: ["d"], slot: 2 }, slot.mint);
  for (const asset of KAKU_SAN_ASSETS) current = applyKakuSanSubmit(current, { step: "add-token", vault: VAULT, shareMint: MINT, signatures: ["a"], slot: 3 }, asset.mint);
  current = applyKakuSanSubmit(current, { step: "weights", vault: VAULT, shareMint: MINT, signatures: ["w"], slot: 4 });
  assert.equal(nextKakuSanStep(current).step, "observe");
  current = mergeKakuSanObservation(current, {
    vault: VAULT, shareMint: MINT, exists: true, activeMints: KAKU_SAN_ASSETS.map(asset => asset.mint),
    inactiveDefaults: KAKU_SAN_DEFAULT_SLOTS.map(slot => slot.mint), pythRemaining: false, weightsSet: true, verified: true,
  });
  assert.equal(nextKakuSanStep(current).step, "done");
  assert.equal(loadKakuSanReceipt()?.vault, VAULT);
  assert.equal(parseKakuSanReceipt({ vault: VAULT }), null);
  const resumed = renderAdmin(wallet({ solanaAddress: KAKU_SAN_DEPLOYER }));
  assert.match(resumed, /Resume basket install|Vault ready/);
  assert.doesNotMatch(resumed, />Create Kaku San vault</);
});
