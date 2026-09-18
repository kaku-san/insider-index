import assert from "node:assert/strict";
import { test } from "node:test";
import { FailedTransactionMetadata } from "litesvm";
import { VersionedTransaction, SystemProgram } from "@solana/web3.js";
import { allSevenVm, pk } from "./support/all-seven-vm.mts";
import { cycleTestOwner, cycleTestKeeper } from "./support/cycle-policy.mts";
import { isolateCycleBounty } from "../src/lib/index-vaults/cycle-bounty.ts";
import { cycleInstructions, encodeCycleWire } from "../src/lib/index-vaults/cycle-wire.ts";
import { MAINNET_USDC } from "../src/lib/index-vaults/native-defaults.ts";
import { WSOL_MINT } from "../src/lib/index-vaults/raydium-oracles.ts";

test("canonical bounty reset hard-caps native funding and restores unrelated WSOL atomically", async () => {
  const vm = allSevenVm({ owner: cycleTestOwner.publicKey.toBase58(), keeper: cycleTestKeeper.publicKey.toBase58() });
  vm.seed(vm.owner, WSOL_MINT, 123_456_789n);
  const payload = await vm.native.sdk.buyVaultTx({ buyer: vm.owner, vault_mint: vm.shareMint, contributions: [{ mint: MAINNET_USDC, amount: 100000000 }], rebalance_slippage_bps: 100, per_trade_rebalance_slippage_bps: 50 });
  const original = await cycleInstructions(vm.native, { batches: [{ transactions: [payload.batches[0].transactions[0]] }] }, vm.owner);
  async function build(fundingRaw: string) {
    const result = await isolateCycleBounty({ connection: vm.connection, owner: vm.owner, fundingRaw, maximumRaw: "4374997", instructions: original.instructions });
    return encodeCycleWire({ payer: vm.owner, blockhash: vm.svm.latestBlockhash(), instructions: result.instructions, tables: original.tables, computeUnits: 1400000, microLamports: "0", maxPriorityFeeLamports: "0" });
  }
  // Native initialization actually needs 4,349,997 raw WSOL in this captured bank. The wallet
  // has much more, but one unit below the isolated source requirement MUST fail atomically.
  const short = await build("4349996"), failed = vm.simulate(VersionedTransaction.deserialize(Buffer.from(short.txBase64, "base64")));
  assert(failed instanceof FailedTransactionMetadata);
  assert.match(failed.meta().logs().join("\n"), /insufficient funds/i);
  assert.equal(await vm.balance(vm.owner, WSOL_MINT), 123_456_789n);
  assert.equal(await vm.connection.getAccountInfo(pk(vm.intent)), null);
  const funded = await build("4374997");
  vm.apply({ batches: [{ transactions: [{ tx_b64: funded.txBase64 }] }] });
  assert.equal(await vm.balance(vm.owner, WSOL_MINT), 123_456_789n);
  assert.equal((await vm.native.sdk.fetchRebalanceIntent(vm.intent)).chain_data.bounty.bountyLeft.toString(), "4349997");
  await assert.rejects(isolateCycleBounty({ connection: vm.connection, owner: vm.owner, fundingRaw: "4374998", maximumRaw: "4374997", instructions: original.instructions }), /FUNDING_CAP/);
  await assert.rejects(isolateCycleBounty({ connection: vm.connection, owner: vm.owner, fundingRaw: "1", maximumRaw: "1", instructions: [...original.instructions, SystemProgram.transfer({ fromPubkey: pk(vm.owner), toPubkey: pk(vm.keeper), lamports: 1 })] }), /UNEXPECTED_RECIPIENT/);
});
