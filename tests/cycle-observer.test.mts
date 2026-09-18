import assert from "node:assert/strict";
import { test } from "node:test";
import { address } from "@solana/kit";
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { allSevenVm, definition, pk } from "./support/all-seven-vm.mts";
import { cycleTestPolicy } from "./support/cycle-policy.mts";
import { observeCycle } from "../src/lib/index-vaults/cycle-observer.ts";
import { MAINNET_USDC } from "../src/lib/index-vaults/native-defaults.ts";
import { WSOL_MINT } from "../src/lib/index-vaults/raydium-oracles.ts";

test("observer reconciles actual backing and pending native contributions, never drops zero-target WSOL", async () => {
  const realNow = Date.now;
  try {
    const policy = cycleTestPolicy(), record = { ...definition, keeper: { pubkey: policy.keeper, automationEnabled: true } };
    const vm = allSevenVm({ owner: policy.owner, keeper: policy.keeper }); Date.now = vm.now;
    vm.seed(policy.owner, MAINNET_USDC, 100_000_123n);
    const empty = await observeCycle(vm.native, record, policy);
    assert.equal(empty.shareSupply, 0n); assert.equal(empty.intent, null);
    assert.equal(empty.balance(policy.owner, MAINNET_USDC), 100_000_123n);
    vm.apply(await vm.native.sdk.buyVaultTx({ buyer: policy.owner, vault_mint: policy.shareMint, contributions: [{ mint: MAINNET_USDC, amount: 100_000_000 }], rebalance_slippage_bps: 100, per_trade_rebalance_slippage_bps: 50 }));
    const funded = await observeCycle(vm.native, record, policy);
    assert(funded.intent); assert.notEqual(funded.stateHash, empty.stateHash);
    assert.equal(funded.actualBacking.get(MAINNET_USDC), 100_000_000n);
    assert.equal(funded.balance(policy.owner, MAINNET_USDC), 123n);
    assert.equal(funded.shareSupply, 0n, "contributions are not minted shares or purchase-row ownership");
    const wsolAta = getAssociatedTokenAddressSync(pk(WSOL_MINT), pk(policy.vault), true, TOKEN_PROGRAM_ID);
    const account = vm.svm.getAccount(address(wsolAta.toBase58())); assert(account.exists);
    const data = Buffer.from(account.data); data.writeBigUInt64LE(data.readBigUInt64LE(64) + 1n, 64);
    vm.svm.setAccount({ ...account, data });
    await assert.rejects(observeCycle(vm.native, record, policy), /SUPPORT_BOUNTY_RECONCILIATION/);
  } finally { Date.now = realNow; }
});
