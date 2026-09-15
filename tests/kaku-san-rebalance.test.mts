import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { register } from "node:module";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { MintLayout, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { isRebalanceRequired } from "@symmetry-hq/sdk";
import type { Vault } from "@symmetry-hq/sdk";
import { KAKU_SAN_ASSETS, KAKU_SAN_DEPLOYER, KAKU_SAN_RAYDIUM_POOLS, assertKakuSanKeeper } from "../src/lib/index-vaults/kaku-san.ts";
import { parseKakuSanPrepareRequest } from "../src/lib/index-vaults/kaku-san-create.ts";
import {
  KAKU_SAN_NATIVE_TOKEN_CAP, assertNativeTokenCap, forbidPythNetwork, handleKakuSanStatus, kakuSanDrift,
  kakuSanRebalanceEligibility, nativeRebalanceGates, observeKakuSanVault, parseKakuSanKeeperArgs,
  parseKakuSanStatusRequest, prepareKakuSanKeeperStep,
} from "../src/lib/index-vaults/kaku-san-rebalance.ts";
import { assertNoPythEnvironment, assertRaydiumOnlyVault, planRaydiumPriceUpdate } from "../src/lib/index-vaults/raydium-oracles.ts";
import { NativeVaultBuilders } from "../src/lib/index-vaults/symmetry-adapter.ts";
import { canCreateKakuSan } from "../src/lib/frontend/kaku-san.ts";
import { STUB_WALLET_ADDRESS } from "../src/lib/wallet.ts";

register("./support/ui-loader.mjs", import.meta.url);
const { KakuAdmin } = await import("../src/components/kaku-admin.tsx");
const { PrivySolanaContext } = await import("../src/components/providers/privy-provider.tsx");

const VAULT = new PublicKey(new Uint8Array(32).fill(2)).toBase58();
const MINT = new PublicKey(new Uint8Array(32).fill(3)).toBase58();
const OTHER = new PublicKey(new Uint8Array(32).fill(9)).toBase58();
const BN = (value: number) => ({ isZero: () => value === 0, toString: () => String(value), gt: (other: { toString(): string }) => value > Number(other.toString()) });

function unsignedPayload(payer = KAKU_SAN_DEPLOYER) {
  const payerKey = new PublicKey(payer);
  const message = new TransactionMessage({
    payerKey, recentBlockhash: PublicKey.default.toBase58(),
    instructions: [SystemProgram.transfer({ fromPubkey: payerKey, toPubkey: payerKey, lamports: 1 })],
  }).compileToV0Message();
  return { tx_b64: Buffer.from(new VersionedTransaction(message).serialize()).toString("base64"), payer, message_version: "0" as const, recent_blockhash: "", lookup_tables: [] as string[], instructions: [] };
}

function kakuVault(overrides: { allowAutomation?: number; bounty?: number; activeRebalance?: number; numTokens?: number } = {}): Vault {
  const assets = KAKU_SAN_ASSETS.slice(0, overrides.numTokens ?? KAKU_SAN_ASSETS.length);
  const lut = assets.map(asset => new PublicKey(asset.pool));
  return {
    ownAddress: new PublicKey(VAULT), mint: new PublicKey(MINT), numTokens: assets.length,
    composition: assets.map((asset, i) => ({
      mint: new PublicKey(asset.mint), amount: BN(0), weight: asset.targetWeightBps, active: 1,
      oracleAggregator: { numOracles: 1, oracles: [{ oracleSettings: { oracleType: 1, numRequiredAccounts: 1 }, accountsToLoadLutIds: [0], accountsToLoadLutIndices: [i] }] },
    })),
    lookupTables: { active: [new PublicKey(new Uint8Array(32).fill(4)), new PublicKey(new Uint8Array(32).fill(5))] },
    lutPubkeys: [{ state: { addresses: lut } }, { state: { addresses: [] } }],
    settings: {
      creator: new PublicKey(KAKU_SAN_DEPLOYER), host: new PublicKey(KAKU_SAN_DEPLOYER),
      activeRebalance: BN(overrides.activeRebalance ?? 0), bountyBalance: BN(overrides.bounty ?? 0),
      bountyMint: new PublicKey("So11111111111111111111111111111111111111112"),
      lastAutomationExecutionTimestamp: BN(0),
      automation: {
        allowAutomation: overrides.allowAutomation ?? 0, rebalanceActivationCooldown: 0,
        rebalanceActivationThresholdRelBps: 0, rebalanceActivationThresholdAbsBps: 0,
      },
      schedule: { cycleStartTime: BN(0), cycleDuration: BN(0), automationStart: BN(0), automationEnd: BN(0) },
      fees: { hostPerformanceFeeBps: 0, creatorPerformanceFeeBps: 0, managersPerformanceFeeBps: 0 },
    },
  } as unknown as Vault;
}

function mintAccount() {
  const data = Buffer.alloc(MintLayout.span);
  MintLayout.encode({
    mintAuthorityOption: 0, mintAuthority: PublicKey.default, supply: 0n, decimals: 6,
    isInitialized: true, freezeAuthorityOption: 0, freezeAuthority: PublicKey.default,
  }, data);
  return { data, owner: TOKEN_PROGRAM_ID, lamports: 1, executable: false };
}

function builders(vault: Vault, intents: unknown[] = [], payer = OTHER): NativeVaultBuilders {
  const payload = { batches: [{ transactions: [unsignedPayload(payer)] }] };
  return {
    network: "mainnet-beta",
    connection: {
      getAccountInfo: async () => mintAccount(),
      simulateTransaction: async () => ({ value: { err: null } }),
    },
    assertNetwork: async () => {},
    read: async () => ({ vault, mint: { supply: { toString: () => "0" }, decimals: 6 } }),
    sdk: {
      fetchVaultRebalanceIntents: async () => intents,
      fetchGlobalConfig: async () => { throw new Error("config skip"); },
      rebalanceVaultTx: async () => payload,
    },
    priceUpdateFromVault: async () => ({ payload, plan: {} }),
  } as unknown as NativeVaultBuilders;
}

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
  return renderToStaticMarkup(createElement(PrivySolanaContext.Provider, { value }, createElement(KakuAdmin) as ReactNode));
}

test("drift is versus the supplied targets, not a hardcoded product max of 5", () => {
  const two = [
    { ticker: "AAPLx", mint: KAKU_SAN_ASSETS[0].mint, targetWeightBps: 2000 },
    { ticker: "NVDAx", mint: KAKU_SAN_ASSETS[1].mint, targetWeightBps: 8000 },
  ];
  const vault = {
    numTokens: 2,
    composition: [
      { mint: { toBase58: () => two[0].mint }, weight: 2500, amount: { toString: () => "10" } },
      { mint: { toBase58: () => two[1].mint }, weight: 7500, amount: { toString: () => "20" } },
    ],
  };
  const rows = kakuSanDrift(vault, two);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].driftBps, 500);
  assert.equal(rows[1].driftBps, -500);
  const full = kakuSanDrift(kakuVault());
  assert.equal(full.length, KAKU_SAN_ASSETS.length);
  assert.ok(full.every(row => row.targetWeightBps === 2000 && row.driftBps === 0));
});

test("native token cap fails closed and is the SDK vault cap, not 5", () => {
  assert.equal(KAKU_SAN_NATIVE_TOKEN_CAP, 100);
  assert.doesNotThrow(() => assertNativeTokenCap(5));
  assert.doesNotThrow(() => assertNativeTokenCap(100));
  assert.throws(() => assertNativeTokenCap(101), /NATIVE_TOKEN_CAP: 101 tokens exceeds the native vault cap of 100/);
});

test("keeper early gates match isRebalanceRequired and never force a rebalance", async () => {
  const connection = { getAccountInfo: async () => null } as never;
  const disabled = kakuVault({ allowAutomation: 0, bounty: 1 });
  assert.equal((await isRebalanceRequired(disabled, connection)).valueOf(), false);
  assert.equal(nativeRebalanceGates(disabled).required, false);
  const noBounty = kakuVault({ allowAutomation: 1, bounty: 0 });
  assert.equal(await isRebalanceRequired(noBounty, connection), false);
  assert.match(nativeRebalanceGates(noBounty).reason, /bounty/i);
  const active = kakuVault({ allowAutomation: 1, bounty: 1, activeRebalance: 1 });
  assert.equal(await isRebalanceRequired(active, connection), false);
  assert.match(nativeRebalanceGates(active).reason, /active rebalance/i);
  const eligibility = await kakuSanRebalanceEligibility(disabled, connection);
  assert.equal(eligibility.required, false);
});

test("Kaku San Raydium CLMM bindings price the installed pools; default devnet bindings fail closed", () => {
  const vault = kakuVault();
  assert.doesNotThrow(() => assertRaydiumOnlyVault(vault, KAKU_SAN_RAYDIUM_POOLS));
  assert.throws(() => assertRaydiumOnlyVault(vault), /RAYDIUM_POOL_REQUIRED/);
  const plan = planRaydiumPriceUpdate({ vault, keeper: KAKU_SAN_DEPLOYER, rebalanceIntent: VAULT, bindings: KAKU_SAN_RAYDIUM_POOLS });
  assert.ok(plan.instructions.length >= 1);
  assert.equal(plan.oracleAccounts.flat()[0], KAKU_SAN_ASSETS[0].pool);
});

test("status and keeper parsers refuse other wallets, extra fields, force, and web-signed rebalance", () => {
  assert.throws(() => parseKakuSanStatusRequest({ creator: OTHER, vault: VAULT, shareMint: MINT }), /approved deployer/);
  assert.throws(() => parseKakuSanStatusRequest({ creator: KAKU_SAN_DEPLOYER, vault: VAULT, shareMint: MINT, keypair: "/tmp/id.json" }));
  assert.throws(() => parseKakuSanPrepareRequest({ creator: KAKU_SAN_DEPLOYER, step: "prices", vault: VAULT, shareMint: MINT }), /local keeper CLI/);
  assert.throws(() => parseKakuSanPrepareRequest({ creator: KAKU_SAN_DEPLOYER, step: "rebalance", vault: VAULT, shareMint: MINT }), /local keeper CLI/);
  assert.throws(() => assertKakuSanKeeper(KAKU_SAN_DEPLOYER), /dedicated hot wallet/);
  assert.equal(assertKakuSanKeeper(OTHER), OTHER);
  assert.throws(() => parseKakuSanKeeperArgs(["--force-rebalance", "--vault", VAULT, "--share-mint", MINT]), /Force-rebalance/);
  assert.throws(() => parseKakuSanKeeperArgs(["--execute", "--vault", VAULT, "--share-mint", MINT]), /--keypair/);
  assert.deepEqual(parseKakuSanKeeperArgs(["--vault", VAULT, "--share-mint", MINT]), { mode: "dry-run", vault: VAULT, shareMint: MINT });
  assert.equal(parseKakuSanKeeperArgs(["--dry-run", "--vault", VAULT, "--share-mint", MINT]).mode, "dry-run");
});

test("observe shows 2000 bps drift and prepare rebalance returns no txs when not eligible", async () => {
  const vault = kakuVault({ allowAutomation: 0, bounty: 0 });
  const status = await observeKakuSanVault({ creator: KAKU_SAN_DEPLOYER, vault: VAULT, shareMint: MINT }, builders(vault));
  assert.equal(status.hostEntryFeeBps, 25);
  assert.equal(status.hostExitFeeBps, 0);
  assert.equal(status.estimatedOnly, true);
  assert.equal(status.nativeTokenCap, 100);
  assert.equal(status.drift.length, KAKU_SAN_ASSETS.length);
  assert.ok(status.drift.every(row => row.targetWeightBps === 2000));
  assert.equal(status.eligibility.required, false);
  assert.equal(status.keeper.next, "TARGET_ACTIVE_WAITING");
  const prepared = await prepareKakuSanKeeperStep({ keeper: OTHER, step: "rebalance", vault: VAULT, shareMint: MINT }, builders(vault), false);
  assert.equal(prepared.eligible, false);
  assert.equal(prepared.transactions.length, 0);
  assert.match(prepared.reason ?? "", /Automation is disabled|bounty/i);
});

test("existing intents take priority over a new rebalance", async () => {
  const vault = kakuVault({ allowAutomation: 1, bounty: 1 });
  const intents = [{
    chain_data: { ownAddress: new PublicKey(VAULT), vault: new PublicKey(VAULT), owner: new PublicKey(KAKU_SAN_DEPLOYER), bounty: { bountyLeft: { toString: () => "1" } } },
    formatted_data: { rebalance_type: "vault", current_action: "update_prices" },
  }];
  const prepared = await prepareKakuSanKeeperStep(
    { keeper: OTHER, step: "rebalance", vault: VAULT, shareMint: MINT },
    builders(vault, intents),
    false,
  );
  assert.equal(prepared.eligible, false);
  assert.equal(prepared.transactions.length, 0);
  assert.match(prepared.reason ?? "", /Existing intents/);
});

test("HTTP status is no-store and refuses a non-deployer; HERMES env fails closed", async () => {
  const denied = await handleKakuSanStatus(new Request("http://localhost/api/vaults/kaku-san/status", {
    method: "POST", body: JSON.stringify({ creator: OTHER, vault: VAULT, shareMint: MINT }),
  }), () => builders(kakuVault()));
  assert.equal(denied.status, 400);
  const ok = await handleKakuSanStatus(new Request("http://localhost/api/vaults/kaku-san/status", {
    method: "POST", body: JSON.stringify({ creator: KAKU_SAN_DEPLOYER, vault: VAULT, shareMint: MINT }),
  }), () => builders(kakuVault()));
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("Cache-Control"), "no-store");
  assert.throws(() => assertNoPythEnvironment({ HERMES_URL: "https://hermes.example" } as unknown as NodeJS.ProcessEnv), /PYTH_ENV_FORBIDDEN/);
  await assert.rejects(forbidPythNetwork(() => fetch("https://hermes.pyth.network/v2/updates/price/latest")), /PYTH_NETWORK_FORBIDDEN/);
});

test("kaku-admin can show drift without signing rebalance or enabling Invest Sign", () => {
  const refused = renderAdmin(wallet({ solanaAddress: OTHER }));
  assert.match(refused, /Show drift/);
  assert.match(refused, /2000 bps/);
  assert.doesNotMatch(refused, /Sign update_prices/);
  assert.doesNotMatch(refused, /Nancy|Pelosi|Invest Sign/);
  assert.match(refused, /does not enable public Invest signing/i);
  assert.match(refused, /does not sign rebalance/i);
  const allowed = renderAdmin(wallet({ solanaAddress: KAKU_SAN_DEPLOYER }));
  assert.match(allowed, /automated keeper/i);
  assert.equal(canCreateKakuSan({ mode: "stub", authenticated: true, solanaAddress: STUB_WALLET_ADDRESS }), false);
});

test("server rebalance paths never load a keypair; only the optional CLI script does, and not from the web tree", () => {
  for (const file of [
    "src/lib/index-vaults/kaku-san-create.ts", "src/lib/index-vaults/kaku-san-rebalance.ts",
    "src/app/api/vaults/kaku-san/prepare/route.ts", "src/app/api/vaults/kaku-san/submit/route.ts",
    "src/app/api/vaults/kaku-san/status/route.ts", "src/components/kaku-admin.tsx",
  ]) {
    assert.doesNotMatch(readFileSync(file, "utf8"), /fromSecretKey|Keypair\.from/);
  }
  assert.match(readFileSync("scripts/kaku-san-keeper-tick.mts", "utf8"), /fromSecretKey/);
  assert.match(readFileSync("scripts/kaku-san-keeper-tick.mts", "utf8"), /must not live in the web app tree/);
  assert.match(readFileSync("scripts/kaku-san-keeper-tick.mts", "utf8"), /assertKakuSanKeeper/);
});

test("CLI defaults to dry-run and rejects force/execute-without-keypair without networking", () => {
  for (const args of [["--force-rebalance"], ["--execute", "--vault", VAULT, "--share-mint", MINT], ["--network=mainnet-beta"]]) {
    const result = spawnSync(process.execPath, ["--experimental-strip-types", "scripts/kaku-san-keeper-tick.mts", ...args], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /Force-rebalance|keypath|Unsupported argument|failed-closed/);
  }
});
