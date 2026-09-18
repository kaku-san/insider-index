import assert from "node:assert/strict";
import { test } from "node:test";
import { Keypair, type VersionedTransactionResponse } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { allSevenVm, definition } from "./support/all-seven-vm.mts";
import { localCycleReceipt } from "./support/cycle-receipt-vm.mts";
import { MAINNET_USDC } from "../src/lib/index-vaults/native-defaults.ts";
import { WSOL_MINT } from "../src/lib/index-vaults/raydium-oracles.ts";
import { sha256 } from "../src/lib/index-vaults/amounts.ts";
import { decodeCycleReceipt, type CycleReceiptExpectation } from "../src/lib/index-vaults/cycle-receipts.ts";

test("cancelled native contribution returns an attributable finalized-RPC-shaped USDC credit, never a wallet-wide balance", async () => {
  const signer = Keypair.fromSeed(new Uint8Array(32).fill(37)); // synthetic local test actor only
  const vm = allSevenVm({ owner: signer.publicKey.toBase58() });
  vm.seed(vm.owner, MAINNET_USDC, 100_000_123n);
  vm.apply(await vm.native.sdk.buyVaultTx({ buyer: vm.owner, vault_mint: vm.shareMint, contributions: [{ mint: MAINNET_USDC, amount: 100_000_000 }], rebalance_slippage_bps: 100, per_trade_rebalance_slippage_bps: 50 }));
  vm.apply(await vm.native.sdk.cancelRebalanceIntentTx({ keeper: vm.owner, rebalance_intent: vm.intent }));
  const payload = await vm.native.sdk.redeemTokensTx({ keeper: vm.owner, rebalance_intent: vm.intent });
  const tx = payload.batches.flatMap(b => b.transactions)[0]; assert(tx);
  const receipt = await localCycleReceipt(vm, tx.tx_b64, signer);
  const expected: CycleReceiptExpectation = { signature: receipt.transaction.signatures[0], messageHash: sha256(receipt.transaction.message.serialize()), payer: vm.owner, owner: vm.owner, vault: vm.vault, shareMint: vm.shareMint, operationId: "00000000-0000-4000-8000-000000000037", minSlot: receipt.slot,
    mints: [...definition.vaultLegs.map(l => ({ mint: l.mint, tokenProgram: TOKEN_2022_PROGRAM_ID.toBase58(), decimals: l.decimals })), { mint: MAINNET_USDC, tokenProgram: TOKEN_PROGRAM_ID.toBase58(), decimals: 6 }, { mint: WSOL_MINT, tokenProgram: TOKEN_PROGRAM_ID.toBase58(), decimals: 9 }, { mint: vm.shareMint, tokenProgram: TOKEN_PROGRAM_ID.toBase58(), decimals: 6 }] };
  const decoded = decodeCycleReceipt(receipt, expected);
  assert.equal(decoded.credits.length, 1);
  assert.equal(decoded.credits[0].receivedRaw, "100000000");
  assert.equal(await vm.balance(vm.owner, MAINNET_USDC), 100_000_123n);
  assert.equal(decoded.tokenDelta(vm.owner, MAINNET_USDC), 100_000_000n);
  assert.equal(decoded.ownerShareDelta, 0n);
  assert.equal((await vm.native.sdk.redeemTokensTx({ keeper: vm.owner, rebalance_intent: vm.intent })).batches.flatMap(b => b.transactions).length, 0);
  assert.throws(() => decodeCycleReceipt(receipt, { ...expected, messageHash: "0".repeat(64) }), /IDENTITY_OR_FAILURE/);
  assert.throws(() => decodeCycleReceipt(receipt, { ...expected, owner: vm.keeper }), /CLAIM_SCOPE/);
  assert.throws(() => decodeCycleReceipt(receipt, { ...expected, minSlot: receipt.slot + 1 }), /IDENTITY_OR_FAILURE/);
  const missing = { ...receipt, meta: { ...receipt.meta!, innerInstructions: null } };
  assert.throws(() => decodeCycleReceipt(missing, expected), /METADATA_INCOMPLETE/);
  const tampered: VersionedTransactionResponse = { ...receipt, meta: { ...receipt.meta!, postTokenBalances: receipt.meta!.postTokenBalances!.map(b => b.owner === vm.owner ? { ...b, uiTokenAmount: { ...b.uiTokenAmount, amount: "100000122" } } : b) } };
  assert.throws(() => decodeCycleReceipt(tampered, expected), /CREDIT_DELTA_MISMATCH/);
  assert.throws(() => decoded.assertConversion(MAINNET_USDC, "1", "1"), /CONVERSION_BOUNDS/);
});
