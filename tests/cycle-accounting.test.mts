import assert from "node:assert/strict";
import { test } from "node:test";
import { cycleMintRounding, assertMintEffects, attributeCycleClaim, creditSaleAmount, applyCreditSale } from "../src/lib/index-vaults/cycle-accounting.ts";
import { MAINNET_USDC } from "../src/lib/index-vaults/native-defaults.ts";

test("raw-share bootstrap floor does not erase backing; subsequent deposits must not dilute either side silently", () => {
  assert.equal(cycleMintRounding({ beforeSupply: "0", grossMinted: "99", beforeValueQ: 0n, contributedValueQ: 99_800_000n, usdcPriceQ: 1n }).lossUsdcRaw, "0");
  assert.equal(cycleMintRounding({ beforeSupply: "100", grossMinted: "1", beforeValueQ: 100_000_000n, contributedValueQ: 1_500_000n, usdcPriceQ: 1n }).lossUsdcRaw, "495050");
  assert.equal(cycleMintRounding({ beforeSupply: "100", grossMinted: "2", beforeValueQ: 100_000_000n, contributedValueQ: 1_500_000n, usdcPriceQ: 1n }).existingHolderDilutionUsdcRaw, "490197");
  assert.throws(() => cycleMintRounding({ beforeSupply: "0", grossMinted: "1", beforeValueQ: 1n, contributedValueQ: 10n, usdcPriceQ: 1n }), /UNPRICED_OR_UNOWNED/);
  assert.throws(() => cycleMintRounding({ beforeSupply: "0", grossMinted: "1", beforeValueQ: 0n, contributedValueQ: 10n, usdcPriceQ: 0n }), /UNPRICED_OR_UNOWNED/);
});
test("mint supply, fee ATA, native accrual and both sides of rounding reconcile with integer arithmetic", () => {
  const p = { beforeSupply: "0", afterSupply: "1009", beforeOutstanding: "0", afterOutstanding: "1009", ownerShareDelta: "1007", feeShareDelta: "2", feeAccrualDelta: "2", minNetSharesRaw: "1007", beforeValueQ: 0n, contributedValueQ: 1_009_000_000n, usdcPriceQ: 1n, maxRoundingLossUsdcRaw: "0" };
  assert.equal(assertMintEffects(p).feeSharesRaw, "2");
  assert.throws(() => assertMintEffects({ ...p, feeShareDelta: "0" }), /MINT_OR_FEE/);
  assert.throws(() => assertMintEffects({ ...p, feeAccrualDelta: "1" }), /MINT_OR_FEE/);
  assert.throws(() => assertMintEffects({ ...p, afterOutstanding: "1010" }), /SUPPLY_DIVERGENCE/);
  assert.throws(() => assertMintEffects({ ...p, minNetSharesRaw: "1008" }), /MINT_OR_FEE/);
  assert.throws(() => assertMintEffects({ ...p, beforeSupply: "1000", beforeOutstanding: "1000", ownerShareDelta: "9", feeShareDelta: "0", feeAccrualDelta: "0", minNetSharesRaw: "1", beforeValueQ: 1_000_000_000n, contributedValueQ: 9_999_999n }), /UNSAFE_SHARE_ROUNDING/);
  assert.throws(() => assertMintEffects({ ...p, beforeSupply: "1000", beforeOutstanding: "1000", ownerShareDelta: "9", feeShareDelta: "0", feeAccrualDelta: "0", minNetSharesRaw: "1", beforeValueQ: 1_000_000_000n, contributedValueQ: 8_999_999n }), /UNSAFE_SHARE_ROUNDING/);
});
test("claim debits equal only this owner's credits; interrupted sales cannot consume preexisting tokens, foreign operations or duplicate receipts", () => {
  const binding = { vault: "v", owner: "o", operationId: "op" };
  const input = { ...binding, signature: "local-simulation", instructionIndex: 2,
    beforeClaim: new Map([["stock", 100n], [MAINNET_USDC, 3n]]), afterClaim: new Map([["stock", 20n], [MAINNET_USDC, 0n]]),
    beforeWallet: new Map([["stock", 123n], [MAINNET_USDC, 50n]]), afterWallet: new Map([["stock", 203n], [MAINNET_USDC, 53n]]),
    programs: new Map([["stock", "program"], [MAINNET_USDC, "program"]]) };
  const credits = attributeCycleClaim(input);
  assert.equal(creditSaleAmount(credits, binding, "stock"), 80n);
  assert.equal(creditSaleAmount(credits, binding, MAINNET_USDC), 0n);
  applyCreditSale(credits, binding, "stock", "30");
  assert.equal(creditSaleAmount(credits, binding, "stock"), 50n);
  assert.throws(() => applyCreditSale(credits, binding, "stock", "51"), /EXCEEDS_CREDITS/);
  assert.throws(() => creditSaleAmount(credits, { ...binding, vault: "another-index" }, "stock"), /FOREIGN_CREDIT/);
  assert.throws(() => creditSaleAmount([...credits, credits[0]], binding, "stock"), /DUPLICATE/);
  assert.throws(() => attributeCycleClaim({ ...input, afterWallet: new Map([["stock", 202n], [MAINNET_USDC, 53n]]) }), /ATTRIBUTION_MISMATCH/);
  assert.throws(() => attributeCycleClaim({ ...input, beforeWallet: new Map([...input.beforeWallet, ["unrelated", 2n]]), afterWallet: new Map([...input.afterWallet, ["unrelated", 1n]]) }), /ATTRIBUTION_MISMATCH/);
});
