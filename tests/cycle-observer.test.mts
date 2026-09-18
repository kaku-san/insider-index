import assert from "node:assert/strict";
import { test } from "node:test";
import { PublicKey } from "@solana/web3.js";
import { address, lamports } from "@solana/kit";
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
    vm.seed(policy.keeper, MAINNET_USDC, 200_000_000n);
    vm.apply(await vm.native.sdk.buyVaultTx({ buyer: policy.keeper, vault_mint: policy.shareMint, contributions: [{ mint: MAINNET_USDC, amount: 200_000_000 }], rebalance_slippage_bps: 100, per_trade_rebalance_slippage_bps: 50 }));
    const concurrent = await observeCycle(vm.native, record, policy);
    assert.equal(concurrent.actualBacking.get(MAINNET_USDC), 300_000_000n, "other investors remain separate fully accounted liabilities");
    assert.equal(concurrent.intent!.chain_data.owner.toBase58(), policy.owner);
    assert.equal(concurrent.intent!.chain_data.tokens.find(t => t.mint.toBase58() === MAINNET_USDC)!.amount.toString(), "100000000");
    const usdcAta = getAssociatedTokenAddressSync(pk(MAINNET_USDC), pk(policy.vault), true), canonical = vm.svm.getAccount(address(usdcAta.toBase58())); assert(canonical.exists);
    const foreignKey = new PublicKey(new Uint8Array(32).fill(72)).toBase58(), foreignData = Buffer.from(canonical.data); foreignData.writeBigUInt64LE(100_000_000n, 64);
    vm.knownAddresses.add(foreignKey);
    vm.svm.setAccount({ ...canonical, address: address(foreignKey), data: foreignData });
    await assert.rejects(observeCycle(vm.native, record, policy), /UNTRACKED_VAULT_ASSETS/);
    const withUnreachable = await observeCycle(vm.native, record, policy, "recovery");
    assert.equal(withUnreachable.actualBacking.get(MAINNET_USDC), 300_000_000n);
    assert.equal(withUnreachable.untrackedVaultAccounts.find(a => a.address === foreignKey)?.amountRaw, "100000000");
    const deficient = Buffer.from(canonical.data); deficient.writeBigUInt64LE(200_000_000n, 64);
    vm.svm.setAccount({ ...canonical, data: deficient });
    await assert.rejects(observeCycle(vm.native, record, policy, "recovery"), /BACKING/, "unreachable noncanonical money cannot conceal a canonical deficit");
    vm.svm.setAccount(canonical);
    foreignData.writeBigUInt64LE(0n, 64); foreignData[108] = 2; // a frozen, empty spam account must not strand recovery
    vm.svm.setAccount({ ...canonical, address: address(foreignKey), data: foreignData });
    assert.equal((await observeCycle(vm.native, record, policy)).actualBacking.get(MAINNET_USDC), 300_000_000n);
    const wsolAta = getAssociatedTokenAddressSync(pk(WSOL_MINT), pk(policy.vault), true, TOKEN_PROGRAM_ID);
    const account = vm.svm.getAccount(address(wsolAta.toBase58())); assert(account.exists);
    const data = Buffer.from(account.data); data.writeBigUInt64LE(data.readBigUInt64LE(64) + 1n, 64);
    vm.svm.setAccount({ ...account, data, lamports: lamports(BigInt(account.lamports) + 1n) });
    await assert.rejects(observeCycle(vm.native, record, policy), /SUPPORT_BOUNTY_RECONCILIATION/);
    const recovery = await observeCycle(vm.native, record, policy, "recovery");
    assert.equal(recovery.unaccountedBacking.get(WSOL_MINT), 1n, "retain donation evidence, not NAV/credits; allow return of independent claims");
  } finally { Date.now = realNow; }
});
