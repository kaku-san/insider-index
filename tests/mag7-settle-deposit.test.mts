import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { RebalanceAction, RebalanceType } from "@symmetry-hq/sdk/dist/layouts/intents/rebalanceIntent.js";
import { getSwapPairs } from "@symmetry-hq/sdk/dist/states/intents/rebalanceIntent.js";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { MAINNET_USDC, NATIVE_DEFAULT_BINDINGS } from "../src/lib/index-vaults/native-defaults.ts";
import { buildCycleRoute } from "../src/lib/index-vaults/cycle-routes.ts";
import { buildCycleFillWire } from "../src/lib/index-vaults/cycle-wire.ts";
import { legBindings } from "../src/lib/index-vaults/keeper-tick.ts";
import { allSevenVm, definition } from "./support/all-seven-vm.mts";

register("./support/ui-loader.mjs", import.meta.url);
const { lockedMag7DepositIntentAddresses, mag7MintPlan, mag7SkippableRouteReason, parseArgs, settleMag7IntentBurst } = await import("../scripts/mag7-settle-deposit.mts");

const VAULT = "AwDFvjEPPwdF1YgXV8asNt6LeEFDduinYneCn6mHDAsh";
const OTHER_VAULT = "8vQmbDWWSph7qQvSdvYcJ4W3xQnn6Nwg3Bh85P6iyReL";
const OWNER = "Jh7cFNUT5FrtBwKakApsc3Gg5aTQjsZtYxa4dbrCoB8";
const key = (value: string) => ({ toBase58: () => value });

function intent(pubkey: string, vault = VAULT, action = RebalanceAction.UpdatePrices, type = RebalanceType.Deposit) {
  return { formatted_data: { pubkey }, chain_data: { vault: key(vault), owner: key(OWNER), rebalanceType: type, currentAction: action } };
}

test("Mag7 watcher defaults to the fixed vault and keeps external-key safeguards", () => {
  const defaults = parseArgs([]);
  assert.equal(defaults.watchVault, true);
  assert.equal(defaults.pollMs, 300_000);
  assert.equal(defaults.execute, false);
  assert.deepEqual(parseArgs(["--watch-vault", "--dry-run"]), defaults);
  assert.equal(parseArgs(["--watch-vault", "--execute", "--keypair", "/external/keeper.json", "--watch", "--interval-seconds", "60"]).pollMs, 60_000);
  assert.throws(() => parseArgs(["--watch-vault", "--execute"]), /--keypair/);
  assert.throws(() => parseArgs(["--owner", OWNER, "--watch-vault"]), /single-intent/);
  assert.throws(() => parseArgs(["--watch-vault", "--interval-seconds", "4"]), /5 to 86400/);
});

test("Mag7 watcher selects every locked Mag7 deposit but no unlocked or foreign intent", () => {
  assert.deepEqual(lockedMag7DepositIntentAddresses([
    intent("locked-price"), intent("locked-auction", VAULT, RebalanceAction.Auction), intent("locked-price"),
    intent("unlocked", VAULT, RebalanceAction.DepositTokens), intent("inactive", VAULT, RebalanceAction.NotActive),
    intent("other-vault", OTHER_VAULT), intent("withdraw", VAULT, RebalanceAction.UpdatePrices, RebalanceType.Withdraw),
  ]), ["locked-price", "locked-auction"]);
});

test("Mag7 auction burst immediately walks seven legs in four two-swap-capped fills", async () => {
  const fills = [["one", "two"], ["three", "four"], ["five", "six"], ["seven"]];
  const sentWithSpent: bigint[] = [];
  const results = await settleMag7IntentBurst(parseArgs([]), 0n, "seven-leg-auction", async (_options, spent, intentAddress) => {
    sentWithSpent.push(spent);
    const filled = fills.shift();
    if (!filled) return { action: "wait", reason: "All Mag7 investment legs are filled", intent: intentAddress, signatures: [], spent };
    return { action: "fill", intent: intentAddress, filled, signatures: [`fill-${filled[0]}`], spent: spent + 1n };
  });

  assert.deepEqual(results.filter(result => result.action === "fill").flatMap(result => result.filled), ["one", "two", "three", "four", "five", "six", "seven"]);
  assert.deepEqual(sentWithSpent, [0n, 1n, 2n, 3n, 4n]);
  assert.equal(results.at(-1)?.action, "wait");
});

test("Mag7 auction burst stops at the per-poll SOL cap", async () => {
  let attemptedFills = 0;
  const results = await settleMag7IntentBurst(parseArgs([]), 0n, "capped-auction", async (_options, spent, intentAddress) => {
    attemptedFills++;
    return { action: "fill", intent: intentAddress, filled: ["one", "two"], signatures: ["fill"], spent: spent + 50_000_000n };
  });

  assert.equal(attemptedFills, 1);
  assert.equal(results.length, 1);
});

test("Mag7 settler skips only dust route failures and mints its filled subset", () => {
  assert.equal(mag7SkippableRouteReason(new Error("CYCLE_ROUTE_MINIMUM_UNSATISFIABLE")), "CYCLE_ROUTE_MINIMUM_UNSATISFIABLE");
  assert.equal(mag7SkippableRouteReason(new Error("CYCLE_NO_FULL_SIZE_ROUTE")), "CYCLE_NO_FULL_SIZE_ROUTE");
  assert.equal(mag7SkippableRouteReason(new Error("CYCLE_POOL_OWNER")), null);

  const plan = mag7MintPlan({
    investmentLegMints: ["filled", "dust", "skipped"],
    tokens: [{ mint: "filled", amount: "42" }, { mint: "dust", amount: "0" }, { mint: "skipped", amount: "0" }, { mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", amount: "1500000" }],
    wsolMint: "So11111111111111111111111111111111111111112",
  });
  assert.equal(plan.mayMint, true);
  assert.deepEqual(plan.filledLegMints, ["filled"]);
  assert.deepEqual(plan.skippedLegMints, ["dust", "skipped"]);
  assert.equal(plan.unspentUsdcRaw, "1500000");

  const noFill = mag7MintPlan({ investmentLegMints: ["dust"], tokens: [{ mint: "dust", amount: "0" }], wsolMint: "wsol" });
  assert.deepEqual(noFill, { mayMint: false, reason: "MAG7_NO_FILLED_LEGS_DO_NOT_MINT", filledLegMints: [], skippedLegMints: ["dust"] });
});

test("Symmetry mints a Mag7 deposit after a dust route skip with USDC left in the intent", async () => {
  const vm = allSevenVm(), realNow = Date.now;
  Date.now = vm.now;
  try {
    vm.seed(vm.owner, MAINNET_USDC, 100_000_000n);
    vm.seed(vm.keeper, MAINNET_USDC, 5_000_000n);
    for (const leg of definition.vaultLegs) {
      vm.seed(vm.owner, leg.mint, 1n, TOKEN_2022_PROGRAM_ID);
      vm.seed(vm.keeper, leg.mint, 1n, TOKEN_2022_PROGRAM_ID);
    }
    vm.apply(await vm.native.sdk.buyVaultTx({ buyer: vm.owner, vault_mint: vm.shareMint, contributions: [{ mint: MAINNET_USDC, amount: 100_000_000 }], rebalance_slippage_bps: 100, per_trade_rebalance_slippage_bps: 50 }));
    vm.apply(await vm.native.sdk.lockDepositsTx({ buyer: vm.owner, vault_mint: vm.shareMint }));
    let intent = (await vm.native.sdk.fetchRebalanceIntent(vm.intent)).chain_data;
    vm.time(Number(intent.executionStartTime.toString()) + 1);
    vm.apply((await vm.native.priceUpdateFromVault(await vm.native.sdk.fetchVault(vm.vault), vm.keeper, vm.intent, [...legBindings(definition.vaultLegs), ...NATIVE_DEFAULT_BINDINGS])).payload);
    intent = (await vm.native.sdk.fetchRebalanceIntent(vm.intent)).chain_data;
    vm.time(Number(intent.auctions[0].startTime.toString()) + 57);
    intent = (await vm.native.sdk.fetchRebalanceIntent(vm.intent)).chain_data;
    let skipped = 0, fill: { route: Awaited<ReturnType<typeof buildCycleRoute>>; maxRepaymentRaw: string } | undefined;
    for (const pair of getSwapPairs(intent, await vm.native.sdk.fetchVault(vm.vault)).filter(pair => pair.outMint === MAINNET_USDC)) {
      const leg = definition.vaultLegs.find(candidate => candidate.mint === pair.inMint);
      assert(leg);
      try {
        const route = await buildCycleRoute({ connection: vm.connection, leg, owner: vm.keeper, inputMint: MAINNET_USDC, outputMint: leg.mint, amountInRaw: String(pair.outAmount), minimumOutRaw: String(pair.inAmount), slippageBps: 50, maxAgeMs: 60_000, metadata: vm.metadata, now: vm.now });
        fill = { route, maxRepaymentRaw: String(pair.inAmount) };
        break;
      } catch (error) {
        assert.equal(mag7SkippableRouteReason(error), "CYCLE_ROUTE_MINIMUM_UNSATISFIABLE");
        skipped++;
      }
    }
    assert(fill);
    assert(skipped > 0);
    const wire = await buildCycleFillWire({ native: vm.native, keeper: vm.keeper, vault: vm.vault, intent: vm.intent, fills: [fill], computeUnits: 1_400_000, microLamports: "0", maxPriorityFeeLamports: "0" });
    vm.apply({ batches: [{ transactions: [{ tx_b64: wire.txBase64 }] }] });
    intent = (await vm.native.sdk.fetchRebalanceIntent(vm.intent)).chain_data;
    const plan = mag7MintPlan({ investmentLegMints: definition.vaultLegs.map(leg => leg.mint), tokens: intent.tokens.map(token => ({ mint: token.mint.toBase58(), amount: token.amount.toString() })), wsolMint: "So11111111111111111111111111111111111111112" });
    if (!plan.mayMint) assert.fail(plan.reason ?? "Mag7 partial mint plan refused");
    assert(plan.skippedLegMints.length > 0);
    if (plan.unspentUsdcRaw === undefined) assert.fail("Mag7 partial mint plan lacks unspent USDC");
    assert(BigInt(plan.unspentUsdcRaw) > 0n);
    vm.time(Number(intent.auctions[2].endTime.toString()) + 1);
    vm.apply(await vm.native.sdk.mintTx({ keeper: vm.keeper, rebalance_intent: vm.intent }));
    assert(await vm.balance(vm.owner, vm.shareMint) > 0n);
  } finally {
    Date.now = realNow;
  }
});
