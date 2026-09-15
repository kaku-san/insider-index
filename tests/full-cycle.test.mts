import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { Keypair, PublicKey } from "@solana/web3.js";
import { CYCLE_STAGES, cycleProven, missingCycleStages, planCreateVault, publicInvestSignAllowed, PROGRAM_CONSTANT_PYTHNET_ACCOUNTS } from "../src/lib/index-vaults/full-cycle.ts";
import type { CycleReceipt, CreateLeg } from "../src/lib/index-vaults/full-cycle.ts";
import { canSignDevnetDeposit, DEVNET_DEPOSIT_SIGNING_ENABLED, DEVNET_TEST_VAULT } from "../src/lib/index-vaults/devnet-contract.ts";
import { discloseNativeCaps, NATIVE_CAPS } from "../src/lib/index-vaults/native-caps.ts";
import { evaluateRebalanceRequired, rebalanceInputFromVault } from "../src/lib/index-vaults/rebalance-eligibility.ts";
import type { RebalanceGateInput } from "../src/lib/index-vaults/rebalance-eligibility.ts";
import { VAULT_RELEASE } from "../src/lib/index-vaults/release.ts";
import { assertAllowedPriceUrl, priceFetch, selectQuoteVenue } from "../src/lib/index-vaults/vault-prices.ts";
import { DEVNET_RAYDIUM_POOLS, WSOL_MINT } from "../src/lib/index-vaults/raydium-oracles.ts";
import { assertKeeperHotWallet, planKeeperCycle, planZapIn, planZapOut } from "../src/lib/index-vaults/zap.ts";
import { NATIVE_USDC_EXIT_VERIFIED, PUBLIC_FUNDS_ENABLED } from "../src/lib/index-vaults/symmetry-adapter.ts";

const key = (n: number) => new PublicKey(new Uint8Array(32).fill(n)).toBase58();
const onCurve = () => Keypair.generate().publicKey.toBase58();
const USDC = "USDCoctVLVnvTXBEuP9s8hntucdJokbo17RwHuNXemT";
const AAPL = key(11), AMZN = key(12), NVDA = key(13), GOOG = key(14), META = key(15);
const identity = { network: "devnet" as const, vaultAccount: DEVNET_TEST_VAULT.vaultAccount, shareMint: DEVNET_TEST_VAULT.shareMint };
const sig = "2".repeat(88);
const receipt = (stage: CycleReceipt["stage"], extra: Partial<CycleReceipt> = {}): CycleReceipt => ({
  stage, network: "devnet", vaultAccount: identity.vaultAccount, shareMint: identity.shareMint, signature: sig, slot: 10, observedAt: "2026-09-15T00:00:00.000Z", ...extra,
});
const fiveStock = (): CreateLeg[] => [
  { mint: AAPL, targetWeightBps: 2000, oracleKind: "raydium_clmm" },
  { mint: AMZN, targetWeightBps: 2000, oracleKind: "raydium_clmm" },
  { mint: NVDA, targetWeightBps: 2000, oracleKind: "raydium_clmm" },
  { mint: GOOG, targetWeightBps: 2000, oracleKind: "raydium_clmm" },
  { mint: META, targetWeightBps: 2000, oracleKind: "raydium_clmm" },
];
const quote = (mint: string, venue: "raydium" | "jupiter", inMint: string, outMint: string, inAmountRaw: string, outAmountRaw: string) => ({ mint, venue, inMint, outMint, inAmountRaw, outAmountRaw });

function gate(partial: Partial<RebalanceGateInput> = {}): RebalanceGateInput {
  const token = { mint: AAPL, weight: 5000, amountRaw: 0n, priceQuote: 1n, validated: true };
  const usdc = { mint: USDC, weight: 5000, amountRaw: 200_000n, priceQuote: 1n, validated: true };
  return {
    allowAutomation: 1, activeRebalance: 0n, bountyBalance: 1n, nowSeconds: 1_800_000_000,
    cycleStartTime: 0n, cycleDuration: 0n, automationStart: 0n, automationEnd: 10n ** 12n,
    lastAutomationExecutionTimestamp: 0n, rebalanceActivationCooldown: 0n,
    rebalanceActivationThresholdRelBps: 1, rebalanceActivationThresholdAbsBps: 1,
    bountyMint: key(9), tokens: [token, usdc], quotesLoaded: true, ...partial,
  };
}

test("native cap is 100; hundreds of names cannot be one vault", () => {
  assert.equal(NATIVE_CAPS.maxTokensPerVault, 100);
  assert.equal(discloseNativeCaps(5).priceUpdateTransactions, 1);
  assert.equal(discloseNativeCaps(15).redeemTransferTransactions, 2);
  assert.equal(discloseNativeCaps(100).hundredsOfNames, "impossible-in-one-vault");
  assert.throws(() => discloseNativeCaps(101), /NATIVE_TOKEN_CAP/);
});

test("price URLs: Raydium/Jupiter allowed, Hermes/Pyth forbidden before fetch", async () => {
  assert.equal(selectQuoteVenue(WSOL_MINT, DEVNET_RAYDIUM_POOLS), "raydium");
  assert.equal(selectQuoteVenue(AAPL, DEVNET_RAYDIUM_POOLS), "jupiter");
  assert.doesNotThrow(() => assertAllowedPriceUrl("https://api.jup.ag/swap/v1/quote"));
  assert.doesNotThrow(() => assertAllowedPriceUrl("https://api-v3.raydium.io/pools/info/mint"));
  for (const url of ["https://hermes.pyth.network/v2/updates/price/latest", "https://hermes.pythdata.com/", "http://pyth.network/"]) {
    assert.throws(() => assertAllowedPriceUrl(url), /HERMES_PYTH_FORBIDDEN/);
  }
  const previous = globalThis.fetch;
  let contacted = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => { contacted++; return previous(input); }) as typeof fetch;
  try {
    assert.throws(() => { void priceFetch("https://hermes.pyth.network/v2/updates/price/latest"); }, /HERMES_PYTH_FORBIDDEN/);
    assert.equal(contacted, 0);
  } finally { globalThis.fetch = previous; }
});

test("eligibility AND rule is local and never fetches Hermes", () => {
  const previous = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error("fetch must not run"); }) as typeof fetch;
  try {
    assert.equal(evaluateRebalanceRequired(gate({ allowAutomation: 0 })).required, false);
    assert.equal(evaluateRebalanceRequired(gate({ bountyBalance: 0n })).required, false);
    assert.equal(evaluateRebalanceRequired(gate({ quotesLoaded: false })).required, null);
    assert.equal(evaluateRebalanceRequired(gate()).required, true);
    assert.equal(evaluateRebalanceRequired(gate({
      tokens: [
        { mint: AAPL, weight: 5000, amountRaw: 100_000n, priceQuote: 1n, validated: true },
        { mint: USDC, weight: 5000, amountRaw: 100_000n, priceQuote: 1n, validated: true },
      ],
    })).required, false);
    const unpriceable = evaluateRebalanceRequired(gate({ tokens: [{ mint: AAPL, weight: 10000, amountRaw: 1n, priceQuote: null, validated: false }] }));
    assert.equal(unpriceable.required, false);
    const view = {
      numTokens: 2,
      settings: {
        bountyMint: new PublicKey(key(9)),
        automation: { allowAutomation: 1, rebalanceActivationCooldown: { toString: () => "0" }, rebalanceActivationThresholdRelBps: 1, rebalanceActivationThresholdAbsBps: 1 },
        activeRebalance: { toString: () => "0" }, bountyBalance: { toString: () => "1" },
        schedule: { cycleStartTime: { toString: () => "0" }, cycleDuration: { toString: () => "0" }, automationStart: { toString: () => "0" }, automationEnd: { toString: () => "1000000000000" } },
        lastAutomationExecutionTimestamp: { toString: () => "0" },
      },
      composition: [
        { mint: new PublicKey(AAPL), weight: 5000, amount: { toString: () => "0" } },
        { mint: new PublicKey(USDC), weight: 5000, amount: { toString: () => "200000" } },
      ],
    };
    assert.equal(evaluateRebalanceRequired(rebalanceInputFromVault(view, 1_800_000_000, null)).required, null);
  } finally { globalThis.fetch = previous; }
});

test("keeper and adapter source never import SDK isRebalanceRequired or hermes.pyth.network", () => {
  for (const path of ["../workers/stocklana-keeper.ts", "../src/lib/index-vaults/symmetry-adapter.ts", "../src/lib/index-vaults/rebalance-eligibility.ts"]) {
    const source = readFileSync(new URL(path, import.meta.url), "utf8");
    assert.equal(source.includes("isRebalanceRequired"), false, path);
    assert.equal(source.includes("hermes.pyth.network"), false, path);
  }
});

test("create refuses Pyth composition, resumes one vault, host 25/0", () => {
  const deployer = onCurve(), host = key(4), strategy = key(5), keeper = onCurve();
  const plan = planCreateVault({ deployer, host, strategy, keeper, legs: fiveStock() });
  assert.equal(plan.defaultPythWsolUsdcSlots, false);
  assert.equal(plan.oneVault, true);
  assert.equal(plan.hostEntryFeeBps, 25);
  assert.equal(plan.hostExitFeeBps, 0);
  assert.equal(plan.vault, null);
  assert.ok(plan.blockers.includes("BROADCAST_DISABLED"));
  assert.equal(plan.programConstantPythnetAccounts.wsol, PROGRAM_CONSTANT_PYTHNET_ACCOUNTS.wsol);
  const resume = planCreateVault({ deployer, host, strategy, keeper, legs: fiveStock(), existingDraft: { vault: key(2), mint: key(3) } });
  assert.equal(resume.phase, "CREATE_RESUME");
  assert.equal(resume.vault, key(2));
  assert.throws(() => planCreateVault({ deployer, host, strategy, keeper, legs: [{ mint: AAPL, targetWeightBps: 10000, oracleKind: "pyth" }] }), /PYTH_COMPOSITION_FORBIDDEN/);
  assert.throws(() => planCreateVault({ deployer: host, host, strategy, keeper, legs: fiveStock() }), /separate/);
});

test("zap in splits USDC at target bps, returns unused, never guarantees shares", () => {
  const quotes = [
    quote(AAPL, "raydium", USDC, AAPL, "100", "50"),
    quote(AMZN, "jupiter", USDC, AMZN, "100", "40"),
    quote(NVDA, "jupiter", USDC, NVDA, "100", "30"),
    quote(GOOG, "raydium", USDC, GOOG, "100", "20"),
    quote(META, "jupiter", USDC, META, "100", "10"),
  ];
  const plan = planZapIn({
    usdcMint: USDC, usdcAmountRaw: "1000",
    assets: fiveStock().map(({ mint, targetWeightBps }) => ({ mint, targetWeightBps })),
    quotes,
  });
  assert.equal(plan.estimatedOnly, true);
  assert.equal(plan.estimatedSharesRaw, null);
  assert.equal(plan.hostEntryFeeBps, 25);
  assert.equal(plan.unusedUsdcRaw, "0");
  assert.equal(plan.legs.every(l => l.usdcInRaw === "200"), true);
  assert.equal(plan.legs[0].venue, "raydium");
  assert.equal(plan.legs[1].venue, "jupiter");
  const dust = planZapIn({
    usdcMint: USDC, usdcAmountRaw: "10",
    assets: [{ mint: AAPL, targetWeightBps: 3333 }, { mint: AMZN, targetWeightBps: 3333 }, { mint: NVDA, targetWeightBps: 3334 }],
    quotes: quotes.slice(0, 3),
  });
  assert.equal(dust.unusedUsdcRaw, "1");
  assert.throws(() => planZapIn({ usdcMint: USDC, usdcAmountRaw: "1000", assets: fiveStock().map(({ mint, targetWeightBps }) => ({ mint, targetWeightBps })), quotes: quotes.slice(0, 1) }), /ZAP_QUOTE_REQUIRED/);
});

test("zap out is USDC only; user does not receive xStocks; host 0", () => {
  const plan = planZapOut({
    usdcMint: USDC,
    holdings: [{ mint: AAPL, amountRaw: "50" }, { mint: AMZN, amountRaw: "40" }, { mint: USDC, amountRaw: "7" }],
    quotes: [quote(AAPL, "raydium", AAPL, USDC, "50", "90"), quote(AMZN, "jupiter", AMZN, USDC, "40", "10")],
  });
  assert.deepEqual(plan.userReceives, [{ mint: USDC, amountRaw: "107" }]);
  assert.equal(plan.hostExitFeeBps, 0);
  assert.equal(plan.userReceives.some(r => r.mint !== USDC), false);
  assert.ok(plan.blockers.includes("USER_MUST_NOT_RECEIVE_XSTOCK_BAG"));
});

test("keeper is a dedicated hot wallet and is not a user click", () => {
  const deployer = onCurve(), host = key(4), strategy = key(5), keeper = onCurve();
  const plan = planKeeperCycle({ keeper, deployer, host, strategy, tokenCount: 5, signerKind: "keeper-hot-wallet" });
  assert.deepEqual(plan.steps, ["update_prices", "rebalance"]);
  assert.equal(plan.signerKind, "keeper-hot-wallet");
  assert.throws(() => planKeeperCycle({ keeper, deployer, host, strategy, tokenCount: 5, signerKind: "phantom" }), /KEEPER_NOT_USER_CLICK/);
  assert.throws(() => assertKeeperHotWallet(deployer, { deployer, host, strategy }), /KEEPER_MUST_NOT_BE_DEPLOYER/);
});

test("public Invest Sign stays off without a full-cycle receipt and without release flags", () => {
  assert.equal(VAULT_RELEASE.publicFundsEnabled, false);
  assert.equal(VAULT_RELEASE.publicInvestSign, false);
  assert.equal(VAULT_RELEASE.nativeUsdcExitVerified, false);
  assert.equal(PUBLIC_FUNDS_ENABLED, false);
  assert.equal(NATIVE_USDC_EXIT_VERIFIED, false);
  assert.equal(DEVNET_DEPOSIT_SIGNING_ENABLED, false);
  assert.equal(canSignDevnetDeposit(null), false);
  const complete = CYCLE_STAGES.map(stage => receipt(stage));
  assert.equal(cycleProven(complete, identity), true);
  assert.deepEqual(missingCycleStages(complete.slice(0, 4), identity), ["zap-out"]);
  assert.equal(publicInvestSignAllowed(complete, identity), false);
  const open = { publicFundsEnabled: true, nativeUsdcExitVerified: true, publicInvestSign: true } as const;
  assert.equal(publicInvestSignAllowed(complete, identity, open), true);
  assert.equal(publicInvestSignAllowed(complete.slice(0, 4), identity, open), false);
  assert.equal(publicInvestSignAllowed(complete.map(r => r.stage === "mint" ? { ...r, vaultAccount: key(2) } : r), identity, open), false);
});

test("vault:cycle CLI is offline dry-run and rejects execute", () => {
  const help = spawnSync(process.execPath, ["--experimental-strip-types", "scripts/vault-full-cycle.mts", "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0);
  const bad = spawnSync(process.execPath, ["--experimental-strip-types", "scripts/vault-full-cycle.mts", "--execute"], { encoding: "utf8" });
  assert.equal(bad.status, 1);
  const run = spawnSync(process.execPath, ["--experimental-strip-types", "scripts/vault-full-cycle.mts"], { encoding: "utf8" });
  assert.equal(run.status, 0);
  const body = JSON.parse(run.stdout);
  assert.equal(body.proven, false);
  assert.equal(body.publicInvestSignAllowed, false);
  assert.equal(body.broadcasts, 0);
  assert.deepEqual(body.missing, [...CYCLE_STAGES]);
});
