import test from "node:test";
import assert from "node:assert/strict";
import { Keypair, TransactionInstruction, VersionedTransaction } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  JUPITER_V6_PROGRAM_ID, USDC_LEG, ata, computeNav, depositIx, keeperSwapIx, mockPoolPda, mockSetPriceIx, mockSwapIx,
  previewDeposit, previewWithdraw, updatePricesIx, withdrawInKindIx, withdrawIx,
} from "../src/lib/nav-vault/program.ts";
import { prepareNavDeposit, prepareNavWithdraw } from "../src/lib/nav-vault/prepare.ts";
import { navVaultVm, seedIndex, PRICE_A, PRICE_B, type NavVm } from "./support/nav-vault-vm.mts";

type Seeded = ReturnType<typeof seedIndex>;

function postPrices(vm: NavVm, s: Seeded, prices = [PRICE_A, PRICE_B]) {
  vm.must(vm.send([updatePricesIx(vm.vault(s.indexId), s.keeper.publicKey, prices)], s.keeper), "update prices");
  vm.advance(1); // marks must be at least one slot old before a deposit uses them
}
function navOf(vm: NavVm, s: Seeded) {
  const v = vm.vault(s.indexId);
  return { v, usdc: vm.balance(v.usdcAccount), legs: v.legs.map(l => vm.balance(l.account)), supply: vm.supply(v.shareMint), nav: computeNav(v, vm.balance(v.usdcAccount), v.legs.map(l => vm.balance(l.account))) };
}
function deposit(vm: NavVm, s: Seeded, user: Keypair, amount: bigint, minShares = 0n) {
  const v = vm.vault(s.indexId);
  vm.mintTo(user, v.shareMint, user.publicKey, 0n); // idempotent share ATA (payer = user)
  return vm.send([depositIx(v, user.publicKey, amount, minShares)], user);
}
/** Keeper swap through the mock venue: in/out are vault leg selectors. */
function keeperSwap(vm: NavVm, s: Seeded, signer: Keypair, inLeg: number, outLeg: number, amountIn: bigint, minOut = 0n, overrides: { venueMinOut?: bigint; userSrc?: import("@solana/web3.js").PublicKey } = {}) {
  const v = vm.vault(s.indexId);
  const mintOf = (leg: number) => leg === USDC_LEG ? s.usdc : v.legs[leg]!.mint;
  const accountOf = (leg: number) => leg === USDC_LEG ? v.usdcAccount : v.legs[leg]!.account;
  const programOf = (leg: number) => leg === USDC_LEG ? TOKEN_PROGRAM_ID : v.legs[leg]!.tokenProgram;
  const stock = inLeg === USDC_LEG ? outLeg : inLeg;
  const swap = mockSwapIx({
    user: s.accounts.authority, baseMint: v.legs[stock]!.mint, quoteMint: s.usdc, inMint: mintOf(inLeg), outMint: mintOf(outLeg),
    userSrc: overrides.userSrc ?? accountOf(inLeg), userDst: accountOf(outLeg), amountIn, minOut: overrides.venueMinOut ?? 0n,
    inTokenProgram: programOf(inLeg), outTokenProgram: programOf(outLeg),
  });
  return vm.send([keeperSwapIx({ vault: v, keeper: signer.publicKey, inLeg, outLeg, amountIn, minOut, swap })], signer);
}
const failsWith = (result: { ok: boolean; logs: string[]; error: string }, name: string) => {
  assert.equal(result.ok, false, `expected ${name} failure`);
  assert.match(result.logs.join("\n"), new RegExp(`Error Code: ${name}`), `expected ${name}, got:\n${result.logs.join("\n")}`);
};

test("deposit mints shares at NAV in the same instruction: first deposit 1:1 on the net amount, 0.25% entry fee to the fee account", () => {
  const vm = navVaultVm();
  const s = seedIndex(vm);
  postPrices(vm, s);
  const v = vm.vault(s.indexId);
  assert.equal(v.entryFeeBps, 25);
  assert.equal(v.bufferBps, 500);
  vm.must(deposit(vm, s, s.alice, 1_000_000_000n), "alice deposit");
  const fee = 2_500_000n; // ceil(1000 USDC x 25 bps)
  assert.equal(vm.balance(s.feeAccount), fee);
  assert.equal(vm.balance(v.usdcAccount), 1_000_000_000n - fee);
  assert.equal(vm.balance(ata(s.alice.publicKey, v.shareMint)), 1_000_000_000n - fee, "first deposit into an empty vault mints 1:1 on the net USDC");
  assert.equal(vm.supply(v.shareMint), 997_500_000n);
});

test("second deposit prices shares on USDC + stock marks (not the USDC balance) and the fee keeps existing holders undiluted", () => {
  const vm = navVaultVm();
  const s = seedIndex(vm);
  postPrices(vm, s);
  vm.must(deposit(vm, s, s.alice, 1_000_000_000n));
  vm.must(keeperSwap(vm, s, s.keeper, USDC_LEG, 0, 500_000_000n), "keeper buys A");
  vm.must(keeperSwap(vm, s, s.keeper, USDC_LEG, 1, 400_000_000n), "keeper buys B");
  postPrices(vm, s, [220_000_000n, PRICE_B]); // A marks up 10%
  const before = navOf(vm, s);
  assert.equal(before.usdc, 97_500_000n);
  assert.equal(before.legs[0], 2_500_000n);
  assert.equal(before.legs[1], 100_000_000n);
  assert.equal(before.nav, 97_500_000n + 550_000_000n + 400_000_000n, "NAV includes stock marks");
  const expected = previewDeposit({ usdcAmount: 100_000_000n, entryFeeBps: 25, nav: before.nav, supply: before.supply });
  vm.must(deposit(vm, s, s.bob, 100_000_000n, expected.shares), "bob deposit");
  assert.equal(vm.balance(ata(s.bob.publicKey, before.v.shareMint)), expected.shares);
  assert.ok(expected.shares < 100_000_000n * before.supply / before.usdc, "a cash-only total_assets would have overminted");
  const after = navOf(vm, s);
  // Price per share (with the virtual offset) never drops for existing holders.
  assert.ok((after.nav + 1_000_000n) * (before.supply + 1_000_000n) >= (before.nav + 1_000_000n) * (after.supply + 1_000_000n));
  failsWith(deposit(vm, s, s.bob, 100_000_000n, 10n ** 12n), "SlippageExceeded");
});

test("keeper-only authority: prices and swaps refuse any other signer; the keeper cannot deposit", () => {
  const vm = navVaultVm();
  const s = seedIndex(vm);
  failsWith(vm.send([updatePricesIx(vm.vault(s.indexId), s.alice.publicKey, [PRICE_A, PRICE_B])], s.alice), "NotKeeper");
  postPrices(vm, s);
  vm.must(deposit(vm, s, s.alice, 1_000_000_000n));
  failsWith(keeperSwap(vm, s, s.alice, USDC_LEG, 0, 100_000_000n), "NotKeeper");
  failsWith(deposit(vm, s, s.keeper, 100_000_000n), "KeeperCannotDeposit");
});

test("stale or same-slot marks refuse deposit and priced withdraw; the price-free in-kind exit still works", () => {
  const vm = navVaultVm();
  const s = seedIndex(vm);
  failsWith(deposit(vm, s, s.alice, 100_000_000n), "StalePrices"); // never posted
  vm.must(vm.send([updatePricesIx(vm.vault(s.indexId), s.keeper.publicKey, [PRICE_A, PRICE_B])], s.keeper));
  failsWith(deposit(vm, s, s.alice, 100_000_000n), "MarksTooNew");
  vm.advance(1);
  vm.must(deposit(vm, s, s.alice, 100_000_000n));
  vm.advance(301);
  const v = vm.vault(s.indexId);
  failsWith(deposit(vm, s, s.alice, 100_000_000n), "StalePrices");
  failsWith(vm.send([withdrawIx(v, s.alice.publicKey, 1_000_000n, 0n, false)], s.alice), "StalePrices");
  failsWith(keeperSwap(vm, s, s.keeper, USDC_LEG, 0, 10_000_000n), "StalePrices");
  for (const leg of v.legs) vm.mintTo(s.alice, leg.mint, s.alice.publicKey, 0n, leg.tokenProgram);
  const usdcBefore = vm.balance(ata(s.alice.publicKey, s.usdc));
  vm.must(vm.send([withdrawInKindIx(v, s.alice.publicKey, 1_000_000n)], s.alice), "in-kind exit with stale prices");
  assert.equal(vm.balance(ata(s.alice.publicKey, s.usdc)) - usdcBefore, 1_000_000n);
});

test("keeper swap: pinned venue, vault accounts only, min_out, posted-price bound and the 5% USDC buffer floor", () => {
  const vm = navVaultVm();
  const s = seedIndex(vm);
  postPrices(vm, s);
  vm.must(deposit(vm, s, s.alice, 1_000_000_000n));
  // 997.5 USDC NAV: buying 950 would leave 47.5 USDC (< 5%).
  failsWith(keeperSwap(vm, s, s.keeper, USDC_LEG, 0, 950_000_000n), "BufferBreached");
  failsWith(keeperSwap(vm, s, s.keeper, USDC_LEG, 0, 100_000_000n, 500_001n), "SlippageExceeded");
  // A venue fill far below the posted mark is refused even with min_out = 0.
  vm.must(vm.send([mockSetPriceIx(s.admin.publicKey, mockPoolPda(s.legA, s.usdc), 300_000_000n)], s.admin));
  failsWith(keeperSwap(vm, s, s.keeper, USDC_LEG, 0, 100_000_000n), "SwapPriceBound");
  vm.must(vm.send([mockSetPriceIx(s.admin.publicKey, mockPoolPda(s.legA, s.usdc), PRICE_A)], s.admin));
  // Claiming USDC as the input while the venue actually spends leg B is caught by the balance diff.
  vm.must(keeperSwap(vm, s, s.keeper, USDC_LEG, 1, 100_000_000n), "seed B");
  const v = vm.vault(s.indexId);
  const sellsBToUsdc = mockSwapIx({ user: s.accounts.authority, baseMint: s.legB, quoteMint: s.usdc, inMint: s.legB, outMint: s.usdc, userSrc: v.legs[1]!.account, userDst: v.usdcAccount, amountIn: 1_000_000n, minOut: 0n, inTokenProgram: TOKEN_2022_PROGRAM_ID });
  failsWith(vm.send([keeperSwapIx({ vault: v, keeper: s.keeper.publicKey, inLeg: USDC_LEG, outLeg: 0, amountIn: 10_000_000n, minOut: 0n, swap: sellsBToUsdc })], s.keeper), "SwapDrainedAccount");
  vm.must(keeperSwap(vm, s, s.keeper, USDC_LEG, 0, 500_000_000n), "buy A within buffer");
  vm.must(keeperSwap(vm, s, s.keeper, 0, USDC_LEG, 1_000_000n), "sell A back to top up the buffer");
  const state = navOf(vm, s);
  assert.equal(state.legs[0], 1_500_000n);
  assert.equal(state.usdc, 997_500_000n - 600_000_000n + 200_000_000n);
});

test("mainnet build refuses a non-Jupiter venue and non-route Jupiter instructions", () => {
  const vm = navVaultVm("mainnet", { mockAtJupiter: true });
  const s = seedIndex(vm);
  postPrices(vm, s);
  vm.must(deposit(vm, s, s.alice, 1_000_000_000n));
  failsWith(keeperSwap(vm, s, s.keeper, USDC_LEG, 0, 10_000_000n), "SwapProgramNotAllowed");
  const v = vm.vault(s.indexId);
  const notRoute = new TransactionInstruction({ programId: JUPITER_V6_PROGRAM_ID, keys: [{ pubkey: s.accounts.authority, isSigner: true, isWritable: false }], data: Buffer.alloc(16, 7) });
  failsWith(vm.send([keeperSwapIx({ vault: v, keeper: s.keeper.publicKey, inLeg: USDC_LEG, outLeg: 0, amountIn: 1n, minOut: 0n, swap: notRoute })], s.keeper), "SwapProgramNotAllowed");
  const route = new TransactionInstruction({ ...notRoute, data: Buffer.concat([Buffer.from([229, 23, 203, 151, 122, 227, 173, 42]), Buffer.alloc(8)]) });
  const reached = vm.send([keeperSwapIx({ vault: v, keeper: s.keeper.publicKey, inLeg: USDC_LEG, outLeg: 0, amountIn: 1n, minOut: 0n, swap: route })], s.keeper);
  assert.equal(reached.ok, false);
  assert.doesNotMatch(reached.logs.join("\n"), /SwapProgramNotAllowed/, "a Jupiter route discriminator passes the allowlist and reaches the venue");
});

test("withdraw pays USDC from the buffer when it covers the share value", () => {
  const vm = navVaultVm();
  const s = seedIndex(vm);
  postPrices(vm, s);
  vm.must(deposit(vm, s, s.alice, 1_000_000_000n));
  vm.must(keeperSwap(vm, s, s.keeper, USDC_LEG, 0, 500_000_000n));
  const before = navOf(vm, s);
  const shares = 100_000_000n;
  const preview = previewWithdraw({ shares, nav: before.nav, supply: before.supply, usdcBalance: before.usdc, legBalances: before.legs });
  assert.equal(preview.path, "usdc");
  const userUsdc = ata(s.alice.publicKey, s.usdc);
  const usdcBefore = vm.balance(userUsdc);
  vm.must(vm.send([withdrawIx(before.v, s.alice.publicKey, shares, preview.value, false)], s.alice));
  assert.equal(vm.balance(userUsdc) - usdcBefore, preview.value);
  assert.equal(vm.supply(before.v.shareMint), before.supply - shares);
  assert.deepEqual(navOf(vm, s).legs, before.legs, "stocks untouched on the USDC path");
});

test("withdraw falls back to the exact pro-rata in-kind basket when the USDC buffer is short", () => {
  const vm = navVaultVm();
  const s = seedIndex(vm);
  postPrices(vm, s);
  vm.must(deposit(vm, s, s.alice, 1_000_000_000n));
  vm.must(deposit(vm, s, s.bob, 500_000_000n));
  vm.must(keeperSwap(vm, s, s.keeper, USDC_LEG, 0, 800_000_000n));
  vm.must(keeperSwap(vm, s, s.keeper, USDC_LEG, 1, 600_000_000n));
  const before = navOf(vm, s);
  const shares = vm.balance(ata(s.alice.publicKey, before.v.shareMint));
  const preview = previewWithdraw({ shares, nav: before.nav, supply: before.supply, usdcBalance: before.usdc, legBalances: before.legs });
  assert.equal(preview.path, "in-kind");
  failsWith(vm.send([withdrawIx(before.v, s.alice.publicKey, shares, 0n, false)], s.alice), "UsdcBufferShort");
  for (const leg of before.v.legs) vm.mintTo(s.alice, leg.mint, s.alice.publicKey, 0n, leg.tokenProgram);
  const userUsdc = ata(s.alice.publicKey, s.usdc), usdcBefore = vm.balance(userUsdc);
  vm.must(vm.send([withdrawIx(before.v, s.alice.publicKey, shares, withSlippageValue(preview.value), true)], s.alice), "in-kind fallback");
  assert.equal(vm.balance(userUsdc) - usdcBefore, before.usdc * shares / before.supply);
  assert.equal(vm.balance(ata(s.alice.publicKey, s.legA, TOKEN_PROGRAM_ID)), before.legs[0]! * shares / before.supply);
  assert.equal(vm.balance(ata(s.alice.publicKey, s.legB, TOKEN_2022_PROGRAM_ID)), before.legs[1]! * shares / before.supply, "Token-2022 leg delivered");
  assert.deepEqual([preview.usdcOut, ...preview.legOut], [before.usdc * shares / before.supply, ...before.legs.map(b => b * shares / before.supply)]);
  const after = navOf(vm, s);
  assert.equal(after.supply, before.supply - shares);
  // Bob keeps (at least) his proportional claim: rounding stays in the vault.
  assert.ok(after.usdc * before.supply >= before.usdc * after.supply);
  assert.ok(after.legs.every((b, i) => b * before.supply >= before.legs[i]! * after.supply));
});

function withSlippageValue(value: bigint) { return value * 9_950n / 10_000n; }

test("prepare returns exactly ONE transaction each way and those transactions execute", async () => {
  const vm = navVaultVm();
  const s = seedIndex(vm);
  postPrices(vm, s);
  const nowSeconds = Number(vm.svm.getClock().unixTimestamp);
  const dep = await prepareNavDeposit({ connection: vm.connection, network: "devnet", indexId: s.indexId, owner: s.alice.publicKey.toBase58(), amountRaw: "1000000000", nowSeconds });
  assert.equal(dep.transactions.length, 1);
  assert.equal(dep.requires, "user-signature");
  assert.equal(dep.navVault.feeRaw, "2500000");
  const sign = (b64: string, who: Keypair) => { const tx = VersionedTransaction.deserialize(Buffer.from(b64, "base64")); tx.sign([who]); return tx.serialize(); };
  vm.must(vm.sendRaw(sign(dep.transactions[0].messageBase64, s.alice)), "prepared deposit");
  assert.equal(vm.balance(ata(s.alice.publicKey, vm.vault(s.indexId).shareMint)).toString(), dep.estimate.sharesRaw);

  const usdcExit = await prepareNavWithdraw({ connection: vm.connection, network: "devnet", indexId: s.indexId, owner: s.alice.publicKey.toBase58(), shareAmountRaw: "10000000", nowSeconds });
  assert.equal(usdcExit.transactions.length, 1);
  assert.equal(usdcExit.navVault.path, "usdc");
  vm.must(vm.sendRaw(sign(usdcExit.transactions[0].messageBase64, s.alice)), "prepared USDC exit");

  vm.must(keeperSwap(vm, s, s.keeper, USDC_LEG, 0, 550_000_000n));
  vm.must(keeperSwap(vm, s, s.keeper, USDC_LEG, 1, 380_000_000n));
  const rest = vm.balance(ata(s.alice.publicKey, vm.vault(s.indexId).shareMint)).toString();
  const inKind = await prepareNavWithdraw({ connection: vm.connection, network: "devnet", indexId: s.indexId, owner: s.alice.publicKey.toBase58(), shareAmountRaw: rest, nowSeconds });
  assert.equal(inKind.transactions.length, 1);
  assert.equal(inKind.navVault.path, "in-kind");
  assert.match(inKind.estimate.outputSummary, /not a USDC exit/);
  vm.must(vm.sendRaw(sign(inKind.transactions[0].messageBase64, s.alice)), "prepared in-kind exit");
  assert.equal(vm.supply(vm.vault(s.indexId).shareMint), 0n);
  assert.ok(vm.balance(ata(s.alice.publicKey, s.legA)) > 0n && vm.balance(ata(s.alice.publicKey, s.legB, TOKEN_2022_PROGRAM_ID)) > 0n);
});
