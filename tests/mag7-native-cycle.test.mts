import test from "node:test";
import assert from "node:assert/strict";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { ComputeBudgetProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { FailedTransactionMetadata } from "litesvm";
import { getAta } from "@symmetry-hq/sdk/dist/instructions/pda.js";
import { getSwapPairs } from "@symmetry-hq/sdk/dist/states/intents/rebalanceIntent.js";
import { completeKeepTokens } from "../src/lib/index-vaults/symmetry-adapter.ts";
import { WSOL_MINT } from "../src/lib/index-vaults/raydium-oracles.ts";
import { VAULT_RELEASE } from "../src/lib/index-vaults/release.ts";
import { mag7CycleVm, withVmTime, owner, keeper, vaultAddress, shareMint, intentAddress, definition, MAINNET_USDC, ledgerBuild, ledgerQuote, exitBuild, exitQuote, decodeInstruction, pk } from "./support/mag7-cycle-vm.mts";

test("native Mag7 accounting and interrupted redemption: synthetic inventory control, not DEX liquidity or USDC exit", async () => {
  const vm = mag7CycleVm();
  await withVmTime(vm, async () => {
    const auction = await vm.beginDeposit();
    assert.equal(await vm.balance(owner, MAINNET_USDC), 0n);
    assert.equal(await vm.balance(vaultAddress, MAINNET_USDC), 100_000_000n);
    for (const leg of definition.vaultLegs) await vm.testInventory(keeper, leg.mint, 1_000_000_000n, TOKEN_2022_PROGRAM_ID);
    for (let n = 0; n < 7; n++) {
      const intent = (await vm.native.sdk.fetchRebalanceIntent(intentAddress)).chain_data;
      const vault = await vm.native.sdk.fetchVault(vaultAddress);
      const pair = getSwapPairs(intent, vault).find(p => p.outMint === MAINNET_USDC);
      assert(pair, `missing auction leg ${n}`);
      vm.applyPayload(await vm.native.sdk.flashSwapTx({ keeper, vault: vaultAddress, rebalance_intent: intentAddress, mint_in: pair.inMint, mint_out: pair.outMint, amount_in: pair.inAmount, amount_out: pair.outAmount }));
    }
    const beforeMint = (await vm.native.sdk.fetchRebalanceIntent(intentAddress)).chain_data;
    for (const leg of definition.vaultLegs) {
      const token = beforeMint.tokens.find(t => t.mint.toBase58() === leg.mint)!;
      assert.equal(token.amount.toString(), token.targetAmount.toString());
      assert(BigInt(token.amount.toString()) > 0n);
      assert.equal(await vm.balance(vaultAddress, leg.mint, TOKEN_2022_PROGRAM_ID), BigInt(token.amount.toString()));
    }
    vm.time(Number(auction.auctions[2].endTime.toString()) + 1);
    vm.applyPayload(await vm.native.sdk.mintTx({ keeper, rebalance_intent: intentAddress }));
    const postMint = await vm.native.sdk.fetchVault(vaultAddress);
    const supply = await vm.connection.getTokenSupply(pk(shareMint));
    // Existing bootstrap unit precision is deliberately not "fixed" by client display arithmetic.
    assert.equal(supply.value.decimals, 6);
    assert.equal(supply.value.amount, "100");
    assert.equal(postMint.supplyOutstanding.toString(), "100");
    assert.equal(await vm.balance(owner, shareMint), 100n); // 0.000100 displayed shares
    assert.equal(postMint.settings.fees.hostDepositFeeBps, 25);
    assert.equal(postMint.settings.fees.hostWithdrawFeeBps, 0);
    for (const fee of Object.values(postMint.accumulatedFees)) assert.equal(fee.toString(), "0", "native raw-share fee rounding, not a claim that 25 bps was collected");
    const holdings = new Map(postMint.composition.slice(0, postMint.numTokens).map(t => [t.mint.toBase58(), BigInt(t.amount.toString())]));
    assert.equal(holdings.get(MAINNET_USDC), 995043n, "bootstrap incorporates residual cash into backing rather than refunding it");
    assert.equal(holdings.get(WSOL_MINT), 0n);
    assert.equal(await vm.balance(vaultAddress, WSOL_MINT), 0n, "zero-target support checked by actual token balance, not weight");
    for (const leg of definition.vaultLegs) assert.equal(await vm.balance(vaultAddress, leg.mint, TOKEN_2022_PROGRAM_ID), holdings.get(leg.mint));
    await vm.testInventory(keeper, WSOL_MINT, 0n);
    vm.time(Number(vm.svm.getClock().unixTimestamp) + 1);
    vm.applyPayload(await vm.native.sdk.claimBountyTx({ keeper, rebalance_intent: intentAddress }));
    assert.equal(await vm.connection.getAccountInfo(pk(intentAddress)), null);
    // Unrelated user assets are a baseline, never withdrawal credits.
    for (const leg of definition.vaultLegs) await vm.testInventory(owner, leg.mint, 123n, TOKEN_2022_PROGRAM_ID);
    vm.applyPayload(await vm.native.sdk.sellVaultTx({ seller: owner, vault_mint: shareMint, withdraw_amount: 100, keep_tokens: completeKeepTokens(postMint), rebalance_slippage_bps: 100, per_trade_rebalance_slippage_bps: 50 }));
    assert.equal(await vm.balance(owner, shareMint), 0n);
    assert.equal((await vm.connection.getTokenSupply(pk(shareMint))).value.amount, "0");
    const claim = (await vm.native.sdk.fetchRebalanceIntent(intentAddress)).chain_data;
    assert.equal(claim.owner.toBase58(), owner);
    assert.equal(claim.vault.toBase58(), vaultAddress);
    for (const t of claim.tokens) assert.equal(BigInt(t.amount.toString()), holdings.get(t.mint.toBase58()));
    const redeem = await vm.native.sdk.redeemTokensTx({ keeper: owner, rebalance_intent: intentAddress });
    assert.equal(redeem.batches[0].transactions.length, 2);
    vm.apply(redeem.batches[0].transactions[0].tx_b64); // interrupt after seven-token claim
    const pending = (await vm.native.sdk.fetchRebalanceIntent(intentAddress)).chain_data.tokens.filter(t => !t.amount.isZero());
    assert.equal(pending.length, 1);
    assert.equal(pending[0].mint.toBase58(), MAINNET_USDC);
    const resumed = await vm.native.sdk.redeemTokensTx({ keeper: owner, rebalance_intent: intentAddress });
    assert.equal(resumed.batches[0].transactions.length, 1, "resume remaining credits, never burn again or re-claim seven stocks");
    vm.applyPayload(resumed);
    const repeat = await vm.native.sdk.redeemTokensTx({ keeper: owner, rebalance_intent: intentAddress });
    assert.equal(repeat.batches.flatMap(b => b.transactions).length, 0);
    for (const leg of definition.vaultLegs) assert.equal(await vm.balance(owner, leg.mint, TOKEN_2022_PROGRAM_ID), holdings.get(leg.mint)! + 123n);
    assert.equal(await vm.balance(owner, MAINNET_USDC), 995043n);
    // Prove one executable exact-credit conversion against the real deployed DEX; no wallet
    // total is used as the sale amount. Other six legs still need independent route evidence.
    vm.loadDex("exit");
    const credit = holdings.get(exitQuote.inputMint)!;
    assert.equal(BigInt(exitQuote.inAmount), credit);
    assert.equal(exitQuote.outputMint, MAINNET_USDC);
    const tables = await Promise.all(exitBuild.addressLookupTableAddresses.map(async key => {
      const table = (await vm.connection.getAddressLookupTable(pk(key))).value;
      assert(table); return table;
    }));
    const swap = decodeInstruction(exitBuild.swapInstruction);
    // Captured Jupiter Route wire contract: one 4-byte route-plan entry, then u64 input,
    // u64 quoted output, u16 slippage and u8 platform fee. The real program, not an
    // implementation-source match, demonstrates that a raised output floor rejects the sale.
    assert.equal(swap.data.length, 35);
    assert.equal(swap.data.readBigUInt64LE(16), credit);
    const refused = decodeInstruction(exitBuild.swapInstruction);
    refused.data.writeBigUInt64LE(2_000_000n, 24);
    const transaction = (ix: typeof swap) => new VersionedTransaction(new TransactionMessage({ payerKey: pk(owner), recentBlockhash: vm.svm.latestBlockhash(), instructions: [ix, ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 })] }).compileToV0Message(tables));
    const beforeUsdc = await vm.balance(owner, MAINNET_USDC);
    const failure = vm.simulate(transaction(refused));
    assert(failure instanceof FailedTransactionMetadata);
    assert.match(failure.err().toString(), /code: 6001/, "Jupiter rejects the raised output floor atomically");
    assert.equal(await vm.balance(owner, exitQuote.inputMint, TOKEN_2022_PROGRAM_ID), credit + 123n);
    assert.equal(await vm.balance(owner, MAINNET_USDC), beforeUsdc);
    vm.apply(Buffer.from(transaction(swap).serialize()).toString("base64"));
    assert.equal(await vm.balance(owner, exitQuote.inputMint, TOKEN_2022_PROGRAM_ID), 123n, "all unrelated preexisting stock survives the exact-credit sale");
    const converted = (await vm.balance(owner, MAINNET_USDC)) - beforeUsdc;
    assert.equal(converted, 609167n);
    assert(converted >= BigInt(exitQuote.otherAmountThreshold));
    for (const leg of definition.vaultLegs.filter(l => l.mint !== exitQuote.inputMint)) assert.equal(await vm.balance(owner, leg.mint, TOKEN_2022_PROGRAM_ID), holdings.get(leg.mint)! + 123n, "unrelated remaining credits not sold by another leg's conversion");
    assert.equal(VAULT_RELEASE.publicFundsEnabled, true);
    assert.equal(VAULT_RELEASE.nativeUsdcExitVerified, false, "one converted credit is not a seven-leg USDC-only exit");
  });
});

test("deployed native IOC + Jupiter token ledger executes captured real Raydium TSLA swap without selling preexisting keeper assets", async () => {
  const vm = mag7CycleVm();
  await withVmTime(vm, async () => {
    const auction = await vm.beginDeposit();
    vm.loadDex();
    // Existing balances demonstrate that the ledger consumes the flash credit, not the wallet.
    await vm.testInventory(keeper, MAINNET_USDC, 5_000_000n);
    await vm.testInventory(keeper, ledgerQuote.outputMint, 123n, TOKEN_2022_PROGRAM_ID);
    // Captured quote instructions used the public owner address. Only signer/source/destination
    // ATA metas are rebound to the distinct test keeper; pool state and programs are untouched.
    const substitutions = new Map([
      [owner, keeper],
      [getAta(pk(owner), pk(MAINNET_USDC)).toBase58(), getAta(pk(keeper), pk(MAINNET_USDC)).toBase58()],
      [getAta(pk(owner), pk(ledgerQuote.outputMint), TOKEN_2022_PROGRAM_ID).toBase58(), getAta(pk(keeper), pk(ledgerQuote.outputMint), TOKEN_2022_PROGRAM_ID).toBase58()],
    ]);
    const rebind = (ix: Parameters<typeof decodeInstruction>[0]) => decodeInstruction({ ...ix, accounts: ix.accounts.map(a => ({ ...a, pubkey: substitutions.get(a.pubkey) ?? a.pubkey })) });
    vm.time(Number(auction.auctions[0].startTime.toString()) + 65);
    const intent = (await vm.native.sdk.fetchRebalanceIntent(intentAddress)).chain_data;
    const pair = getSwapPairs(intent, await vm.native.sdk.fetchVault(vaultAddress)).find(p => p.inMint === ledgerQuote.outputMint && p.outMint === MAINNET_USDC);
    assert(pair);
    assert.equal(pair.inAmount, 165970);
    assert.equal(pair.outAmount, 611829);
    const payload = await vm.native.sdk.flashSwapTx({ keeper, vault: vaultAddress, rebalance_intent: intentAddress, mint_in: pair.inMint, mint_out: pair.outMint, amount_in: pair.inAmount, amount_out: pair.outAmount, mode: 2,
      jup_token_ledger_ix: rebind(ledgerBuild.tokenLedgerInstruction), jup_swap_ix: rebind(ledgerBuild.swapInstruction), jup_address_lookup_table_addresses: ledgerBuild.addressLookupTableAddresses.map(pk) });
    vm.applyPayload(payload);
    assert.equal(await vm.balance(vaultAddress, MAINNET_USDC), 100_000_000n - 611829n);
    assert.equal(await vm.balance(vaultAddress, pair.inMint, TOKEN_2022_PROGRAM_ID), 165970n);
    assert.equal(await vm.balance(keeper, MAINNET_USDC), 5_000_000n, "unrelated USDC not sold");
    assert.equal(await vm.balance(keeper, pair.inMint, TOKEN_2022_PROGRAM_ID), 123n + 318n, "native auction surplus stays with filler; allocation is an unresolved economic decision");
    const credited = (await vm.native.sdk.fetchRebalanceIntent(intentAddress)).chain_data.tokens.find(t => t.mint.toBase58() === pair.inMint)!;
    assert.equal(credited.amount.toString(), "165970");
    assert.equal(credited.targetAmount.toString(), "165970");
    assert.equal(VAULT_RELEASE.publicInvestSign, true);
  });
});
