import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { DEVNET_DEPOSIT_SIGNING_ENABLED } from "../src/lib/index-vaults/devnet-contract.ts";
import { KAKU_SAN, KAKU_SAN_ASSETS, KAKU_SAN_DEPLOYER, KAKU_SAN_RAYDIUM_POOLS, assertKakuSanDeployer } from "../src/lib/index-vaults/kaku-san.ts";
import {
  assertSignedBy, assertSignedByDeployer, handleKakuSanPrepare, handleKakuSanSubmit, kakuSanConnection,
  kakuSanOracleInput, kakuSanTokenInput, parseKakuSanPrepareRequest, parseKakuSanSubmitRequest,
  payloadTransactions, prepareKakuSanStep,
} from "../src/lib/index-vaults/kaku-san-create.ts";
import { assertNoPythEnvironment, assertRaydiumOnlyToken } from "../src/lib/index-vaults/raydium-oracles.ts";
import { NativeVaultBuilders } from "../src/lib/index-vaults/symmetry-adapter.ts";
import { canCreateKakuSan, signPreparedKakuSan } from "../src/lib/frontend/kaku-san.ts";
import { POST as prepareRoute } from "../src/app/api/vaults/kaku-san/prepare/route.ts";
import { POST as submitRoute } from "../src/app/api/vaults/kaku-san/submit/route.ts";
import { STUB_WALLET_ADDRESS } from "../src/lib/wallet.ts";

register("./support/ui-loader.mjs", import.meta.url);
const { KakuAdmin } = await import("../src/components/kaku-admin.tsx");
const { PrivySolanaContext } = await import("../src/components/providers/privy-provider.tsx");
type TestWallet = {
  ready: boolean; configured: boolean; mode: "live" | "stub" | "unavailable"; authenticated: boolean;
  solanaAddress: string | null; appId: string | null; connect: () => Promise<void>; disconnect: () => Promise<void>;
  signTransaction: (transaction: string, network?: "mainnet-beta" | "devnet") => Promise<string>;
};

const VAULT = new PublicKey(new Uint8Array(32).fill(2)).toBase58();
const MINT = new PublicKey(new Uint8Array(32).fill(3)).toBase58();
const OTHER = new PublicKey(new Uint8Array(32).fill(9)).toBase58();

function unsignedPayload(payer = KAKU_SAN_DEPLOYER) {
  const payerKey = new PublicKey(payer);
  const message = new TransactionMessage({
    payerKey, recentBlockhash: PublicKey.default.toBase58(),
    instructions: [SystemProgram.transfer({ fromPubkey: payerKey, toPubkey: payerKey, lamports: 1 })],
  }).compileToV0Message();
  const tx = new VersionedTransaction(message);
  return { tx_b64: Buffer.from(tx.serialize()).toString("base64"), payer, message_version: "0" as const, recent_blockhash: "", lookup_tables: [] as string[], instructions: [] };
}

function builders(): NativeVaultBuilders {
  const payload = { batches: [{ transactions: [unsignedPayload()] }] };
  return {
    network: "mainnet-beta",
    connection: { simulateTransaction: async () => ({ value: { err: null } }) },
    assertNetwork: async () => {},
    sdk: { createVaultTx: async () => ({ vault: VAULT, mint: MINT, ...payload }) },
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
  assert.throws(() => parseKakuSanSubmitRequest({ creator: KAKU_SAN_DEPLOYER, step: "create", vault: VAULT, shareMint: MINT, signedTransactions: [] }));
});

test("prepare RPC forbids sends, airdrops and devnet; HERMES/PYTH env fails closed", () => {
  assert.throws(() => kakuSanConnection(false, "https://api.devnet.solana.com"), /Mainnet RPC only/);
  const dry = kakuSanConnection(false, "https://api.mainnet-beta.solana.com");
  assert.rejects(() => dry.sendRawTransaction(Buffer.alloc(8)), /not permitted in prepare/);
  assert.rejects(() => dry.requestAirdrop(new PublicKey(KAKU_SAN_DEPLOYER), 1), /not permitted/);
  assert.rejects(() => kakuSanConnection(true, "https://api.mainnet-beta.solana.com").requestAirdrop(new PublicKey(KAKU_SAN_DEPLOYER), 1), /not permitted/);
  assert.throws(() => assertNoPythEnvironment({ HERMES_URL: "https://hermes.example" } as unknown as NodeJS.ProcessEnv), /PYTH_ENV_FORBIDDEN/);
});

test("prepare returns unsigned create transactions and the public vault + share mint", async () => {
  const prepared = await prepareKakuSanStep({ creator: KAKU_SAN_DEPLOYER, step: "create" }, builders());
  assert.equal(prepared.vault, VAULT);
  assert.equal(prepared.shareMint, MINT);
  assert.equal(prepared.step, "create");
  assert.equal(prepared.transactions.length, 1);
  assert.equal(prepared.transactions[0].payer, KAKU_SAN_DEPLOYER);
  assert.equal(prepared.label, KAKU_SAN.label);
  const tx = VersionedTransaction.deserialize(Buffer.from(prepared.transactions[0].txBase64, "base64"));
  assert.ok(tx.signatures[0].every(byte => byte === 0));
  assert.throws(() => payloadTransactions({ batches: [{ transactions: [{ ...unsignedPayload(), payer: OTHER }] }] }, KAKU_SAN_DEPLOYER));
});

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

test("HTTP prepare is no-store and refuses a non-deployer; submit refuses unsigned bytes", async () => {
  const ok = await handleKakuSanPrepare(request({ creator: KAKU_SAN_DEPLOYER }), () => builders());
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("Cache-Control"), "no-store");
  const body = await ok.json();
  assert.equal(body.vault, VAULT);
  assert.equal(body.shareMint, MINT);
  const denied = await handleKakuSanPrepare(request({ creator: OTHER }), () => builders());
  assert.equal(denied.status, 400);
  const unsigned = await handleKakuSanSubmit(request({
    creator: KAKU_SAN_DEPLOYER, step: "create", vault: VAULT, shareMint: MINT, signedTransactions: [unsignedPayload().tx_b64],
  }, "/api/vaults/kaku-san/submit"), () => ({ sendRawTransaction: async () => { throw new Error("should not send"); } } as never));
  assert.equal(unsigned.status, 503);
  assert.equal((await prepareRoute(request({ creator: OTHER }))).status, 400);
  assert.equal((await submitRoute(request({ creator: OTHER, step: "create", vault: VAULT, shareMint: MINT, signedTransactions: ["AA"] }, "/api/vaults/kaku-san/submit"))).status, 400);
});

test("live deployer may sign; stub, preview and any other wallet are refused. Public Invest Sign stays off", async () => {
  assert.equal(canCreateKakuSan({ mode: "live", authenticated: true, solanaAddress: KAKU_SAN_DEPLOYER }), true);
  assert.equal(canCreateKakuSan({ mode: "stub", authenticated: true, solanaAddress: STUB_WALLET_ADDRESS }), false);
  assert.equal(canCreateKakuSan({ mode: "live", authenticated: true, solanaAddress: OTHER }), false);
  assert.equal(DEVNET_DEPOSIT_SIGNING_ENABLED, false);
  const prepared = await prepareKakuSanStep({ creator: KAKU_SAN_DEPLOYER, step: "create" }, builders(), false);
  await assert.rejects(signPreparedKakuSan(prepared, {
    mode: "stub", authenticated: true, solanaAddress: STUB_WALLET_ADDRESS,
    signTransaction: async () => { throw new Error("stub must not sign Kaku San"); },
  }, () => true), /approved deployer/);
});

function wallet(partial: Partial<TestWallet>): TestWallet {
  return {
    ready: true, configured: true, mode: "live", authenticated: true, solanaAddress: OTHER, appId: "test",
    connect: async () => {}, disconnect: async () => {},
    signTransaction: async () => { throw new Error("test wallet does not sign"); },
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
  assert.doesNotMatch(refused, /Nancy|Pelosi|Invest Sign/);
  const stub = renderAdmin(wallet({ mode: "stub", solanaAddress: STUB_WALLET_ADDRESS }));
  assert.match(stub, /live Solana wallet is required/i);
  const allowed = renderAdmin(wallet({ solanaAddress: KAKU_SAN_DEPLOYER }));
  assert.doesNotMatch(allowed, /refused/);
  assert.match(allowed, /AAPLx/);
  assert.match(allowed, /2000 bps/);
});

test("kaku-admin is not linked from nav, footer, sitemap or home, and create never loads a keypair", () => {
  for (const file of ["src/components/site-header.tsx", "src/app/layout.tsx", "src/components/index-home.tsx", "src/app/page.tsx", "src/app/robots.ts"]) {
    const text = readFileSync(file, "utf8");
    assert.doesNotMatch(text, /href=["']\/kaku-admin["']/);
  }
  const robots = readFileSync("src/app/robots.ts", "utf8");
  assert.match(robots, /disallow: \["\/kaku-admin"\]/);
  const create = readFileSync("src/lib/index-vaults/kaku-san-create.ts", "utf8");
  assert.doesNotMatch(create, /fromSecretKey|readFileSync|Keypair\.from/);
  const page = readFileSync("src/app/kaku-admin/page.tsx", "utf8");
  assert.match(page, /index: false/);
});
