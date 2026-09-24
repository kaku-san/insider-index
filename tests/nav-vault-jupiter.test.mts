import test from "node:test";
import assert from "node:assert/strict";
import { address } from "@solana/kit";
import { ComputeBudgetProgram, Keypair, PublicKey, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import {
  NAV_VAULT_PROGRAM_ID, USDC_LEG, decodeRequest, decodeVault, depositIx, fulfillSwapIx, initVaultIx, keeperSwapIx, legIndex, requestPda,
  requestWithdrawIx, settleRequestIx, shareAta, updatePricesIx, vaultPda, vaultTokenAccounts,
} from "../src/lib/nav-vault/program.ts";
import { Clock } from "litesvm";
import { navJupiterVm, withVmTime, owner, definition, MAINNET_USDC, exitBuild, exitQuote, decodeInstruction, pk } from "./support/nav-jupiter-vm.mts";
import { programBinary } from "./support/nav-vault-vm.mts";

/**
 * Mainnet NAV vault build + the captured, hash-checked deployed Jupiter V6 and Raydium CLMM
 * binaries and TSLA→USDC route accounts (tests/fixtures/nav-jupiter). The vault authority PDA is
 * the Jupiter taker via `keeper_swap` CPI. Vault TSLA inventory is a SYNTHETIC local input (not
 * DEX evidence); the sale itself runs through the real deployed programs. Offline, no keys.
 */
test("keeper_swap and a keeper USDC cash-out (fulfill_swap → settle) CPI the real deployed Jupiter V6 route with the vault PDA as taker (Mag7 legs)", async () => {
  const vm = navJupiterVm();
  await withVmTime(vm, async () => {
    vm.loadDex();
    vm.svm.addProgram(address(NAV_VAULT_PROGRAM_ID.toBase58()), programBinary("nav_vault.so"));
    const admin = Keypair.generate(), keeper = Keypair.generate();
    for (const k of [admin, keeper]) vm.svm.airdrop(address(k.publicKey.toBase58()), 5_000_000_000n as never);
    const indexId = "mag7-nav-jupiter-test";
    const legs = definition.vaultLegs.map(leg => ({ mint: pk(leg.mint), tokenProgram: TOKEN_2022_PROGRAM_ID, weightBps: leg.targetWeightBps }));
    const accounts = vaultTokenAccounts(indexId, pk(MAINNET_USDC), legs);
    const send = (ixs: Parameters<typeof vm.wire>[0], payer: Keypair, tables: Awaited<ReturnType<typeof tablesFor>> = []) => {
      const tx = new VersionedTransaction(new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: vm.svm.latestBlockhash(), instructions: ixs }).compileToV0Message(tables));
      assert.ok(tx.serialize().length <= 1232, "fits one packet");
      return vm.apply(Buffer.from(tx.serialize()).toString("base64"));
    };
    const tablesFor = async () => Promise.all(exitBuild.addressLookupTableAddresses.map(async key => (await vm.connection.getAddressLookupTable(pk(key))).value!));
    const feeAccount = getAssociatedTokenAddressSync(pk(MAINNET_USDC), admin.publicKey, true, TOKEN_PROGRAM_ID);
    send([
      createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, feeAccount, admin.publicKey, pk(MAINNET_USDC)),
      createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, accounts.usdc, accounts.authority, pk(MAINNET_USDC)),
    ], admin);
    send(legs.slice(0, 4).map((leg, i) => createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, accounts.legs[i]!, accounts.authority, leg.mint, leg.tokenProgram)), admin);
    send(legs.slice(4).map((leg, i) => createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, accounts.legs[i + 4]!, accounts.authority, leg.mint, leg.tokenProgram)), admin);
    send([initVaultIx({ admin: admin.publicKey, indexId, keeper: keeper.publicKey, usdcMint: pk(MAINNET_USDC), feeAccount, maxPriceAgeSecs: 600, maxSlippageBps: 100, legs })], admin);
    const vault = decodeVault(vaultPda(indexId), (await vm.connection.getAccountInfo(vaultPda(indexId)))!.data);
    assert.equal(vault.legs.length, 7);

    // SYNTHETIC local inventory: the vault holds exactly the captured quote's TSLA input.
    const tsla = legIndex(vault, pk(exitQuote.inputMint));
    const credit = BigInt(exitQuote.inAmount);
    const setAmount = (key: PublicKey, amount: bigint) => {
      const a = vm.svm.getAccount(address(key.toBase58())); assert(a.exists);
      const data = Buffer.from(a.data); data.writeBigUInt64LE(amount, 64); vm.svm.setAccount({ ...a, data });
    };
    setAmount(vault.legs[tsla]!.account, credit);
    // Marks: TSLA from the captured quote (USDC raw per 10^8 raw TSLA); other legs any positive mark.
    const tslaMark = BigInt(exitQuote.otherAmountThreshold) * 100_000_000n / credit;
    send([updatePricesIx(vault, keeper.publicKey, vault.legs.map((_, i) => i === tsla ? tslaMark : 1_000_000n))], keeper);

    const substitutions = new Map([
      [owner, accounts.authority.toBase58()],
      [getAssociatedTokenAddressSync(pk(exitQuote.inputMint), pk(owner), true, TOKEN_2022_PROGRAM_ID).toBase58(), vault.legs[tsla]!.account.toBase58()],
      [getAssociatedTokenAddressSync(pk(MAINNET_USDC), pk(owner), true, TOKEN_PROGRAM_ID).toBase58(), vault.usdcAccount.toBase58()],
    ]);
    const swap = decodeInstruction({ ...exitBuild.swapInstruction, accounts: exitBuild.swapInstruction.accounts.map(a => ({ ...a, pubkey: substitutions.get(a.pubkey) ?? a.pubkey })) });
    const minOut = BigInt(exitQuote.otherAmountThreshold);
    const wrap = (min: bigint) => [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 }), keeperSwapIx({ vault, keeper: keeper.publicKey, inLeg: tsla, outLeg: USDC_LEG, amountIn: credit, minOut: min, swap })];
    const tables = await tablesFor();

    // The vault's own min_out is enforced on top of Jupiter's floor.
    assert.throws(() => send(wrap(minOut * 2n), keeper, tables));
    send(wrap(minOut), keeper, tables);
    assert.equal(await vm.balance(accounts.authority.toBase58(), exitQuote.inputMint, TOKEN_2022_PROGRAM_ID), 0n, "vault sold exactly its TSLA credit");
    const received = await vm.balance(accounts.authority.toBase58(), MAINNET_USDC);
    assert.equal(received, 609167n, "real Raydium CLMM fill through Jupiter");
    assert.ok(received >= minOut);
    for (const [i, leg] of vault.legs.entries()) if (i !== tsla) assert.equal(await vm.balance(accounts.authority.toBase58(), leg.mint.toBase58(), TOKEN_2022_PROGRAM_ID), 0n);

    // USDC cash-out via keeper through the SAME real Jupiter route: a user deposits, requests all its
    // shares (carving the vault's TSLA slice), the keeper sells that slice with fulfill_swap into the
    // request, and settle pays USDC. SYNTHETIC local inputs: user USDC balance and vault TSLA credit.
    const user = Keypair.generate();
    vm.svm.airdrop(address(user.publicKey.toBase58()), 5_000_000_000n as never);
    const userUsdc = getAssociatedTokenAddressSync(pk(MAINNET_USDC), user.publicKey, true, TOKEN_PROGRAM_ID);
    send([
      createAssociatedTokenAccountIdempotentInstruction(user.publicKey, userUsdc, user.publicKey, pk(MAINNET_USDC)),
      createAssociatedTokenAccountIdempotentInstruction(user.publicKey, shareAta(user.publicKey, vault.shareMint), user.publicKey, vault.shareMint, TOKEN_2022_PROGRAM_ID),
    ], user);
    setAmount(userUsdc, 10_000_000n);
    const c = vm.svm.getClock();
    vm.svm.setClock(new Clock(c.slot + 2n, c.epochStartTimestamp, c.epoch, c.leaderScheduleEpoch, c.unixTimestamp));
    send([ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), depositIx(vault, user.publicKey, 10_000_000n, 0n)], user, tables);
    const shares = await vm.balance(user.publicKey.toBase58(), vault.shareMint.toBase58(), TOKEN_2022_PROGRAM_ID);
    assert.ok(shares > 0n);
    setAmount(vault.legs[tsla]!.account, credit);
    send([ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), requestWithdrawIx(vault, user.publicKey, { shares, minUsdc: 1n, nonce: 1n, inKindNow: false })], user, tables);
    const requestAddress = requestPda(vault.address, user.publicKey, 1n);
    const carved = decodeRequest(requestAddress, (await vm.connection.getAccountInfo(requestAddress))!.data);
    assert.equal(carved.legAmounts[tsla], credit, "the request carved the whole TSLA credit (sole holder)");
    const fulfill = fulfillSwapIx({ vault, keeper: keeper.publicKey, request: requestAddress, inLeg: tsla, amountIn: credit, minOut: minOut, swap });
    send([ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 }), fulfill], keeper, tables);
    const converted = decodeRequest(requestAddress, (await vm.connection.getAccountInfo(requestAddress))!.data);
    assert.equal(converted.legAmounts[tsla], 0n);
    assert.equal(converted.usdcOwed - carved.usdcOwed, 609167n, "real Jupiter proceeds credited to the request");
    send([settleRequestIx(vault, keeper.publicKey, converted)], keeper, tables);
    assert.equal(await vm.balance(user.publicKey.toBase58(), MAINNET_USDC), converted.usdcOwed, "USDC paid to the owner");
    assert.equal(await vm.connection.getAccountInfo(requestAddress), null);
  });
});
