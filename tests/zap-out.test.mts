import assert from "node:assert/strict";
import test from "node:test";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { SYMMETRY_PROGRAM_ID } from "../src/lib/index-vaults/symmetry-adapter.ts";
import {
  EMPTY_KEEP_FORBIDDEN, assertKeepSelectionForUsdcGoal, claimDeltas, exitLegsFromDefinition, ownerClaimInstructions,
  planZapOut, proRataClaimRaw, usdcAuctionKeepTokens,
} from "../src/lib/index-vaults/zap-out.ts";

const owner = "8RZ4GrQDsctRGrW4tDZcYZRqFAW23eWkrVcJQ1DH7GyX";
const vault = "AwDFvjEPPwdF1YgXV8asNt6LeEFDduinYneCn6mHDAsh";
const usdc = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const aapl = "H6pLh8nFv1teY9G6JAVQuZQxeUvGfwYf1aPXHkDPDRph";
const msft = "9ihGfswnUZ6MysSR3KgmrZ57FXDVAiAQ6sEHwLuWwzJ4";
const nvda = "So11111111111111111111111111111111111111112";

function legs(count: number) {
  const mints = [aapl, msft, nvda, owner, vault, usdc];
  return Array.from({ length: count }, (_, index) => ({ mint: mints[index] ?? PublicKey.unique().toBase58(), ticker: `N${index + 1}`, targetWeightBps: index === count - 1 ? 10_000 - (count - 1) : 1 }));
}

test("USDC exit never treats an empty keep list as a buy target", () => {
  assert.throws(() => assertKeepSelectionForUsdcGoal([]), new RegExp(EMPTY_KEEP_FORBIDDEN));
  assert.deepEqual(usdcAuctionKeepTokens(usdc), [usdc]);
  assert.notDeepEqual(usdcAuctionKeepTokens(usdc), []);
});

test("zap-out sells claimed DB-leg amounts, not weights, for any N", () => {
  const three = exitLegsFromDefinition([
    { mint: aapl, ticker: "AAPL", targetWeightBps: 5000 },
    { mint: msft, ticker: "MSFT", targetWeightBps: 3000 },
    { mint: nvda, ticker: "NVDA", targetWeightBps: 2000 },
  ]);
  assert.equal(three.length, 3);
  const eleven = exitLegsFromDefinition(legs(11).map((leg, index) => ({ ...leg, targetWeightBps: index === 10 ? 9990 : 1 })));
  assert.equal(eleven.length, 11);
  assert.equal(proRataClaimRaw("1000", "25", "100"), "250");
  const plan = planZapOut({
    indexId: "idx-theme-silicon-hill",
    usdcMint: usdc,
    legs: three,
    claims: [
      { mint: aapl, amountRaw: "7" },
      { mint: msft, amountRaw: "4" },
      { mint: usdc, amountRaw: "11" },
      { mint: owner, amountRaw: "2" },
    ],
    quotes: [{ mint: aapl, amountRaw: "7", minOutRaw: "3" }],
  });
  assert.equal(plan.legCount, 3);
  assert.equal(plan.packaging, "staged");
  assert.equal(plan.atomic, false);
  assert.equal(plan.keeperSubsidyRaw, "0");
  assert.equal(plan.userFundsOnly, true);
  assert.deepEqual(plan.sells, [{ mint: aapl, ticker: "AAPL", amountRaw: "7", minOutRaw: "3" }]);
  assert.equal(plan.sells.some(sell => sell.amountRaw === "5000"), false);
  assert.equal(plan.residuals.find(row => row.mint === msft)?.reason, "jupiter-unavailable");
  assert.equal(plan.residuals.find(row => row.mint === owner)?.reason, "not-a-db-leg");
  assert.equal(plan.residuals.some(row => row.mint === usdc), false);
  assert.match(plan.warning, /leftover stocks and USDC/);
  assert.match(plan.warning, /not a share refund/);
  assert.match(plan.warning, /No keeper funds/);
});

test("owner claim is signed by the owner and does not add a keeper signer", () => {
  const instructions = ownerClaimInstructions({
    owner, vault, claims: [{ mint: aapl, tokenProgram: TOKEN_PROGRAM_ID.toBase58() }, { mint: msft, tokenProgram: TOKEN_PROGRAM_ID.toBase58() }],
  });
  const redeem = instructions.find(ix => ix.programId.toBase58() === SYMMETRY_PROGRAM_ID);
  assert.ok(redeem);
  assert.equal(redeem.keys[0]?.pubkey.toBase58(), owner);
  assert.equal(redeem.keys[0]?.isSigner, true);
  assert.equal(redeem.keys[3]?.pubkey.toBase58(), owner);
  assert.equal(instructions.some(ix => ix.keys.some(key => key.isSigner && key.pubkey.toBase58() !== owner)), false);
  assert.equal(instructions.some(ix => ix.programId.equals(SystemProgram.programId) && ix.keys.some(key => key.pubkey.toBase58() !== owner && key.isSigner)), false);
});

test("claim deltas are the owner increase on that vault transaction, not the whole wallet", () => {
  const intent = "9ihGfswnUZ6MysSR3KgmrZ57FXDVAiAQ6sEHwLuWwzJ4";
  assert.throws(() => claimDeltas({
    owner, vault, intent, feePayer: owner, accountKeys: [owner, vault, intent], failed: true, pre: [], post: [],
  }), /claim transaction failed/);
  const deltas = claimDeltas({
    owner, vault, intent, feePayer: owner, accountKeys: [owner, vault, intent], failed: false,
    pre: [{ mint: aapl, owner, amountRaw: "3" }, { mint: aapl, owner: vault, amountRaw: "100" }],
    post: [{ mint: aapl, owner, amountRaw: "10" }, { mint: aapl, owner: vault, amountRaw: "90" }, { mint: usdc, owner, amountRaw: "4" }],
  });
  assert.deepEqual(deltas, [{ mint: aapl, amountRaw: "7" }, { mint: usdc, amountRaw: "4" }]);
});
