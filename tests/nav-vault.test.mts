import test from "node:test";
import assert from "node:assert/strict";
import { ComputeBudgetProgram, Keypair, PublicKey, TransactionInstruction, VersionedTransaction } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  CLAIM_LEGS_PER_TX, JUPITER_V6_PROGRAM_ID, USDC_LEG, adminRedeemInKindIx, adminSetPricesIx, ata, claimInKindIx, computeNav, crossRequestLegIx,
  decodeRequest, depositIx, fulfillSwapIx, keeperSwapIx, mockPoolPda, mockSetPriceIx, mockSwapIx, previewDeposit, previewWithdraw, requestPda,
  requestWithdrawIx, setMaxDepositIx, setMaxPriceAgeIx, setPausedIx, settleRequestIx, shareAta, updatePricesIx, withdrawIx, type NavVaultState,
} from "../src/lib/nav-vault/program.ts";
import { prepareNavDeposit, prepareNavWithdraw, readNavRequests } from "../src/lib/nav-vault/prepare.ts";
import { keeperTick, markFromQuote, mockVenue, planCycle, planRebalance } from "../src/lib/nav-vault/keeper.ts";
import { navVaultVm, seedIndex, PRICE_A, PRICE_B, type NavVm } from "./support/nav-vault-vm.mts";

type Seeded = ReturnType<typeof seedIndex>;
const CU = ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 });

function send(vm: NavVm, s: Seeded, ixs: TransactionInstruction[], payer: Keypair) { return vm.send([CU, ...ixs], payer, [], [s.lut]); }
function postPrices(vm: NavVm, s: Seeded, prices = s.prices) {
  vm.must(send(vm, s, [updatePricesIx(vm.vault(s.indexId), s.keeper.publicKey, prices)], s.keeper), "update prices");
  vm.advance(1); // marks must be at least one slot old before a deposit uses them
}
function navOf(vm: NavVm, s: Seeded) {
  const v = vm.vault(s.indexId);
  const usdc = vm.balance(v.usdcAccount), legs = v.legs.map(l => vm.balance(l.account));
  return { v, usdc, legs, supply: vm.supply(v.shareMint), nav: computeNav(v, usdc, legs), freeUsdc: usdc - v.reservedUsdc };
}
function sharesOf(vm: NavVm, s: Seeded, who: Keypair) { return vm.balance(shareAta(who.publicKey, vm.vault(s.indexId).shareMint)); }
function deposit(vm: NavVm, s: Seeded, user: Keypair, amount: bigint, minShares = 0n) {
  const v = vm.vault(s.indexId);
  vm.mintTo(user, v.shareMint, user.publicKey, 0n, TOKEN_2022_PROGRAM_ID); // idempotent share ATA (Token-2022)
  return send(vm, s, [depositIx(v, user.publicKey, amount, minShares)], user);
}
/** Mock-venue swap instruction between vault accounts (taker = authority PDA). */
function venueSwap(vm: NavVm, s: Seeded, inLeg: number, outLeg: number, amountIn: bigint, overrides: { userSrc?: PublicKey; inMint?: PublicKey; inProgram?: PublicKey; outMint?: PublicKey; userDst?: PublicKey } = {}) {
  const v = vm.vault(s.indexId);
  const mintOf = (leg: number) => leg === USDC_LEG ? s.usdc : v.legs[leg]!.mint;
  const accountOf = (leg: number) => leg === USDC_LEG ? v.usdcAccount : v.legs[leg]!.account;
  const programOf = (leg: number) => leg === USDC_LEG ? TOKEN_PROGRAM_ID : v.legs[leg]!.tokenProgram;
  const stock = inLeg === USDC_LEG ? outLeg : inLeg;
  return mockSwapIx({
    user: s.accounts.authority, baseMint: v.legs[stock]!.mint, quoteMint: s.usdc, inMint: overrides.inMint ?? mintOf(inLeg), outMint: overrides.outMint ?? mintOf(outLeg),
    userSrc: overrides.userSrc ?? accountOf(inLeg), userDst: overrides.userDst ?? accountOf(outLeg), amountIn, minOut: 0n,
    inTokenProgram: overrides.inProgram ?? programOf(inLeg), outTokenProgram: programOf(outLeg),
  });
}
function keeperSwap(vm: NavVm, s: Seeded, signer: Keypair, inLeg: number, outLeg: number, amountIn: bigint, minOut = 0n) {
  return send(vm, s, [keeperSwapIx({ vault: vm.vault(s.indexId), keeper: signer.publicKey, inLeg, outLeg, amountIn, minOut, swap: venueSwap(vm, s, inLeg, outLeg, amountIn) })], signer);
}
function request(vm: NavVm, s: Seeded, user: Keypair, shares: bigint, opts: { minUsdc?: bigint; inKindNow?: boolean; nonce?: bigint } = {}) {
  const nonce = opts.nonce ?? BigInt(Math.floor(Math.random() * 1e9));
  const result = send(vm, s, [requestWithdrawIx(vm.vault(s.indexId), user.publicKey, { shares, minUsdc: opts.minUsdc ?? 0n, nonce, inKindNow: opts.inKindNow ?? false })], user);
  const address = requestPda(vm.vault(s.indexId).address, user.publicKey, nonce);
  return { result, address, read: () => decodeRequest(address, vm.info(address)!.data) };
}
function ownerAtas(vm: NavVm, s: Seeded, user: Keypair) {
  const v = vm.vault(s.indexId);
  vm.mintTo(user, s.usdc, user.publicKey, 0n);
  for (const leg of v.legs) vm.mintTo(user, leg.mint, user.publicKey, 0n, leg.tokenProgram);
}
const failsWith = (result: { ok: boolean; logs: string[]; error: string }, name: string) => {
  assert.equal(result.ok, false, `expected ${name} failure`);
  assert.match(result.logs.join("\n"), new RegExp(`Error Code: ${name}`), `expected ${name}, got:\n${result.logs.join("\n")}`);
};

test("deposit mints Token-2022 shares at NAV in the same instruction: first deposit 1:1 on the net amount, 0.25% fee", () => {
  const vm = navVaultVm();
  const s = seedIndex(vm);
  postPrices(vm, s);
  const v = vm.vault(s.indexId);
  assert.equal(vm.info(v.shareMint)!.owner.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58());
  vm.must(deposit(vm, s, s.alice, 1_000_000_000n), "alice deposit");
  assert.equal(vm.balance(s.feeAccount), 2_500_000n);
  assert.equal(vm.balance(v.usdcAccount), 997_500_000n);
  assert.equal(sharesOf(vm, s, s.alice), 997_500_000n);
});

test("second deposit prices on free USDC + stock marks and the fee keeps existing holders undiluted", () => {
  const vm = navVaultVm();
  const s = seedIndex(vm);
  postPrices(vm, s);
  vm.must(deposit(vm, s, s.alice, 1_000_000_000n));
  vm.must(keeperSwap(vm, s, s.keeper, USDC_LEG, 0, 500_000_000n), "buy A");
  vm.must(keeperSwap(vm, s, s.keeper, USDC_LEG, 1, 400_000_000n), "buy B");
  postPrices(vm, s, [220_000_000n, PRICE_B]);
  const before = navOf(vm, s);
  assert.equal(before.nav, 97_500_000n + 550_000_000n + 400_000_000n, "NAV includes stock marks");
  const expected = previewDeposit({ usdcAmount: 100_000_000n, entryFeeBps: 25, nav: before.nav, supply: before.supply });
  vm.must(deposit(vm, s, s.bob, 100_000_000n, expected.shares), "bob deposit");
  assert.equal(sharesOf(vm, s, s.bob), expected.shares);
  const after = navOf(vm, s);
  assert.ok((after.nav + 1_000_000n) * (before.supply + 1_000_000n) >= (before.nav + 1_000_000n) * (after.supply + 1_000_000n));
  failsWith(deposit(vm, s, s.bob, 100_000_000n, 10n ** 12n), "SlippageExceeded");
});

test("keeper-only authority; the keeper cannot deposit", () => {
  const vm = navVaultVm();
  const s = seedIndex(vm);
  failsWith(send(vm, s, [updatePricesIx(vm.vault(s.indexId), s.alice.publicKey, s.prices)], s.alice), "NotKeeper");
  postPrices(vm, s);
  vm.must(deposit(vm, s, s.alice, 1_000_000_000n));
  failsWith(keeperSwap(vm, s, s.alice, USDC_LEG, 0, 100_000_000n), "NotKeeper");
  failsWith(deposit(vm, s, s.keeper, 100_000_000n), "KeeperCannotDeposit");
});

test("price band: a mark moving more than 15% is refused unless the admin overrides", () => {
  const vm = navVaultVm();
  const s = seedIndex(vm);
  postPrices(vm, s);
  failsWith(send(vm, s, [updatePricesIx(vm.vault(s.indexId), s.keeper.publicKey, [PRICE_A * 116n / 100n, PRICE_B])], s.keeper), "PriceMoveTooLarge");
  vm.must(send(vm, s, [updatePricesIx(vm.vault(s.indexId), s.keeper.publicKey, [PRICE_A * 115n / 100n, PRICE_B])], s.keeper), "15% move allowed");
  failsWith(send(vm, s, [adminSetPricesIx(vm.vault(s.indexId), s.keeper.publicKey, [PRICE_A * 2n, PRICE_B])], s.keeper), "ConstraintHasOne");
  vm.must(send(vm, s, [adminSetPricesIx(vm.vault(s.indexId), s.admin.publicKey, [PRICE_A * 2n, PRICE_B])], s.admin), "admin override");
  assert.equal(vm.vault(s.indexId).legs[0]!.price, PRICE_A * 2n);
});

test("stale or same-slot marks refuse deposit and instant withdraw; a request then becomes claimable in kind at once", () => {
  const vm = navVaultVm();
  const s = seedIndex(vm);
  failsWith(deposit(vm, s, s.alice, 100_000_000n), "StalePrices");
  vm.must(send(vm, s, [updatePricesIx(vm.vault(s.indexId), s.keeper.publicKey, s.prices)], s.keeper));
  failsWith(deposit(vm, s, s.alice, 100_000_000n), "MarksTooNew");
  vm.advance(1);
  vm.must(deposit(vm, s, s.alice, 100_000_000n));
  vm.advance(301);
  const v = vm.vault(s.indexId);
  failsWith(deposit(vm, s, s.alice, 100_000_000n), "StalePrices");
  failsWith(send(vm, s, [withdrawIx(v, s.alice.publicKey, 1_000_000n, 0n)], s.alice), "StalePrices");
  failsWith(keeperSwap(vm, s, s.keeper, USDC_LEG, 0, 10_000_000n), "StalePrices");
  const r = request(vm, s, s.alice, 1_000_000n);
  vm.must(r.result, "request with stale marks");
  assert.ok(r.read().claimableAt <= Number(vm.svm.getClock().unixTimestamp), "stale marks → in-kind claimable now");
  ownerAtas(vm, s, s.alice);
  const usdcBefore = vm.balance(ata(s.alice.publicKey, s.usdc));
  vm.must(send(vm, s, [claimInKindIx(v, s.alice.publicKey, { address: r.address, owner: s.alice.publicKey }, [0, 1])], s.alice), "claim");
  assert.equal(vm.balance(ata(s.alice.publicKey, s.usdc)) - usdcBefore, 1_000_000n);
  assert.equal(vm.info(r.address), null, "request closed, rent refunded to the owner");
});

test("keeper swap: pinned venue, min_out, posted-price bound, 5% buffer floor, drain protection", () => {
  const vm = navVaultVm();
  const s = seedIndex(vm);
  postPrices(vm, s);
  vm.must(deposit(vm, s, s.alice, 1_000_000_000n));
  failsWith(keeperSwap(vm, s, s.keeper, USDC_LEG, 0, 950_000_000n), "BufferBreached");
  failsWith(keeperSwap(vm, s, s.keeper, USDC_LEG, 0, 100_000_000n, 500_001n), "SlippageExceeded");
  vm.must(send(vm, s, [mockSetPriceIx(s.admin.publicKey, mockPoolPda(s.legA, s.usdc), 300_000_000n)], s.admin));
  failsWith(keeperSwap(vm, s, s.keeper, USDC_LEG, 0, 100_000_000n), "SwapPriceBound");
  vm.must(send(vm, s, [mockSetPriceIx(s.admin.publicKey, mockPoolPda(s.legA, s.usdc), PRICE_A)], s.admin));
  vm.must(keeperSwap(vm, s, s.keeper, USDC_LEG, 1, 100_000_000n), "seed B");
  const v = vm.vault(s.indexId);
  // Declared USDC→A, but the venue actually spends vault leg B into vault USDC.
  const sellsB = mockSwapIx({ user: s.accounts.authority, baseMint: s.legB, quoteMint: s.usdc, inMint: s.legB, outMint: s.usdc, userSrc: v.legs[1]!.account, userDst: v.usdcAccount, amountIn: 1_000_000n, minOut: 0n, inTokenProgram: TOKEN_2022_PROGRAM_ID });
  failsWith(send(vm, s, [keeperSwapIx({ vault: v, keeper: s.keeper.publicKey, inLeg: USDC_LEG, outLeg: 0, amountIn: 10_000_000n, minOut: 0n, swap: sellsB })], s.keeper), "(SwapDrainedAccount|MissingLegAccounts)");
  vm.must(keeperSwap(vm, s, s.keeper, USDC_LEG, 0, 500_000_000n), "buy A within buffer");
  vm.must(keeperSwap(vm, s, s.keeper, 0, USDC_LEG, 1_000_000n), "sell A back");
  const state = navOf(vm, s);
  assert.equal(state.legs[0], 1_500_000n);
});

test("mainnet build refuses a non-Jupiter venue and non-route Jupiter instructions", () => {
  const vm = navVaultVm("mainnet", { mockAtJupiter: true });
  const s = seedIndex(vm);
  postPrices(vm, s);
  vm.must(deposit(vm, s, s.alice, 1_000_000_000n));
  failsWith(keeperSwap(vm, s, s.keeper, USDC_LEG, 0, 10_000_000n), "SwapProgramNotAllowed");
  const v = vm.vault(s.indexId);
  const accounts = [{ pubkey: s.accounts.authority, isSigner: true, isWritable: false }, { pubkey: v.usdcAccount, isSigner: false, isWritable: true }, { pubkey: v.legs[0]!.account, isSigner: false, isWritable: true }];
  const notRoute = new TransactionInstruction({ programId: JUPITER_V6_PROGRAM_ID, keys: accounts, data: Buffer.alloc(16, 7) });
  failsWith(send(vm, s, [keeperSwapIx({ vault: v, keeper: s.keeper.publicKey, inLeg: USDC_LEG, outLeg: 0, amountIn: 1n, minOut: 0n, swap: notRoute })], s.keeper), "SwapProgramNotAllowed");
  const route = new TransactionInstruction({ programId: JUPITER_V6_PROGRAM_ID, keys: accounts, data: Buffer.concat([Buffer.from([229, 23, 203, 151, 122, 227, 173, 42]), Buffer.alloc(8)]) });
  const reached = send(vm, s, [keeperSwapIx({ vault: v, keeper: s.keeper.publicKey, inLeg: USDC_LEG, outLeg: 0, amountIn: 1n, minOut: 0n, swap: route })], s.keeper);
  assert.equal(reached.ok, false);
  assert.doesNotMatch(reached.logs.join("\n"), /SwapProgramNotAllowed/, "a Jupiter route discriminator passes the allowlist and reaches the venue");
});

test("instant withdraw pays USDC from the free buffer when it covers the value", () => {
  const vm = navVaultVm();
  const s = seedIndex(vm);
  postPrices(vm, s);
  vm.must(deposit(vm, s, s.alice, 1_000_000_000n));
  vm.must(keeperSwap(vm, s, s.keeper, USDC_LEG, 0, 500_000_000n));
  const before = navOf(vm, s);
  const shares = 100_000_000n;
  const preview = previewWithdraw({ vault: before.v, shares, nav: before.nav, supply: before.supply, usdcBalance: before.usdc, legBalances: before.legs });
  assert.equal(preview.instant, true);
  ownerAtas(vm, s, s.alice);
  const usdcBefore = vm.balance(ata(s.alice.publicKey, s.usdc));
  vm.must(send(vm, s, [withdrawIx(before.v, s.alice.publicKey, shares, preview.value)], s.alice));
  assert.equal(vm.balance(ata(s.alice.publicKey, s.usdc)) - usdcBefore, preview.value);
  failsWith(send(vm, s, [withdrawIx(before.v, s.alice.publicKey, 800_000_000n, 0n)], s.alice), "UsdcBufferShort");
});

test("USDC cash-out via keeper: request carves the pro-rata slice (other holders unaffected), keeper crosses/sells, settle pays USDC >= min_usdc", () => {
  const vm = navVaultVm();
  const s = seedIndex(vm);
  postPrices(vm, s);
  vm.must(deposit(vm, s, s.alice, 1_000_000_000n));
  vm.must(deposit(vm, s, s.bob, 1_000_000_000n));
  vm.must(keeperSwap(vm, s, s.keeper, USDC_LEG, 0, 1_100_000_000n));
  vm.must(keeperSwap(vm, s, s.keeper, USDC_LEG, 1, 780_000_000n));
  const before = navOf(vm, s);
  const bobValueBefore = sharesOf(vm, s, s.bob) * before.nav / before.supply;
  const shares = sharesOf(vm, s, s.alice);
  const preview = previewWithdraw({ vault: before.v, shares, nav: before.nav, supply: before.supply, usdcBalance: before.usdc, legBalances: before.legs });
  assert.equal(preview.instant, false, "buffer cannot cover alice's full exit");
  const r = request(vm, s, s.alice, shares, { minUsdc: preview.value * 99n / 100n });
  vm.must(r.result, "ONE-signature request");
  const req = r.read();
  assert.deepEqual(req.legAmounts, preview.slice.legs, "carved exactly the pro-rata leg slices");
  assert.equal(req.usdcOwed, preview.slice.usdc);
  const mid = navOf(vm, s);
  // Other holders unaffected: bob's claim is unchanged by the carve.
  assert.ok(sharesOf(vm, s, s.bob) * mid.nav / mid.supply >= bobValueBefore - 2n);
  failsWith(send(vm, s, [claimInKindIx(mid.v, s.alice.publicKey, { address: r.address, owner: s.alice.publicKey }, [0])], s.alice), "NotClaimable");
  // Keeper: sell leg A's slice through the venue into the request; cross leg B against free USDC? (not enough) → sell too.
  vm.must(send(vm, s, [fulfillSwapIx({ vault: mid.v, keeper: s.keeper.publicKey, request: r.address, inLeg: 0, amountIn: req.legAmounts[0]!, minOut: 0n, swap: venueSwap(vm, s, 0, USDC_LEG, req.legAmounts[0]!) })], s.keeper), "fulfill A");
  vm.must(send(vm, s, [fulfillSwapIx({ vault: mid.v, keeper: s.keeper.publicKey, request: r.address, inLeg: 1, amountIn: req.legAmounts[1]!, minOut: 0n, swap: venueSwap(vm, s, 1, USDC_LEG, req.legAmounts[1]!) })], s.keeper), "fulfill B");
  const converted = r.read();
  assert.deepEqual(converted.legAmounts, [0n, 0n]);
  failsWith(send(vm, s, [settleRequestIx(mid.v, s.bob.publicKey, { address: r.address, owner: s.alice.publicKey })], s.bob), "NotClaimable");
  ownerAtas(vm, s, s.alice);
  const usdcBefore = vm.balance(ata(s.alice.publicKey, s.usdc));
  vm.must(send(vm, s, [settleRequestIx(mid.v, s.keeper.publicKey, { address: r.address, owner: s.alice.publicKey })], s.keeper), "settle");
  const paid = vm.balance(ata(s.alice.publicKey, s.usdc)) - usdcBefore;
  assert.equal(paid, converted.usdcOwed);
  assert.ok(paid >= preview.value * 99n / 100n);
  assert.equal(vm.info(r.address), null);
  const after = navOf(vm, s);
  assert.equal(after.v.reservedUsdc, 0n);
  assert.ok(after.v.legs.every(l => l.reserved === 0n));
  assert.ok(sharesOf(vm, s, s.bob) * after.nav / after.supply >= bobValueBefore - 2n, "bob unaffected after settlement");
});

test("cross nets a request against free USDC at the mark; min_usdc unmet → owner claims in kind after the timeout", () => {
  const vm = navVaultVm();
  const s = seedIndex(vm, "idx-test-nav", { requestTimeoutSecs: 60 });
  postPrices(vm, s);
  vm.must(deposit(vm, s, s.alice, 1_000_000_000n));
  vm.must(deposit(vm, s, s.bob, 1_000_000_000n));
  vm.must(keeperSwap(vm, s, s.keeper, USDC_LEG, 0, 1_000_000_000n));
  vm.must(keeperSwap(vm, s, s.keeper, USDC_LEG, 1, 800_000_000n));
  const r = request(vm, s, s.alice, 100_000_000n, { minUsdc: 1_000_000_000n }); // unreachable min
  vm.must(r.result);
  const v = vm.vault(s.indexId);
  vm.must(send(vm, s, [crossRequestLegIx(v, s.keeper.publicKey, r.address, 0)], s.keeper), "cross A at mark");
  assert.equal(r.read().legAmounts[0], 0n);
  vm.must(send(vm, s, [crossRequestLegIx(v, s.keeper.publicKey, r.address, 1)], s.keeper), "cross B at mark");
  failsWith(send(vm, s, [settleRequestIx(v, s.keeper.publicKey, { address: r.address, owner: s.alice.publicKey })], s.keeper), "MinUsdcUnmet");
  ownerAtas(vm, s, s.alice);
  failsWith(send(vm, s, [claimInKindIx(v, s.alice.publicKey, { address: r.address, owner: s.alice.publicKey }, [])], s.alice), "NotClaimable");
  vm.advance(61);
  const owed = r.read().usdcOwed;
  const usdcBefore = vm.balance(ata(s.alice.publicKey, s.usdc));
  vm.must(send(vm, s, [claimInKindIx(v, s.alice.publicKey, { address: r.address, owner: s.alice.publicKey }, [])], s.alice), "owner claims after timeout");
  assert.equal(vm.balance(ata(s.alice.publicKey, s.usdc)) - usdcBefore, owed);
  assert.equal(vm.info(r.address), null);
});

test("pause stops deposits, instant withdraw, keeper swaps and crosses; requests become in-kind and claims stay open", () => {
  const vm = navVaultVm();
  const s = seedIndex(vm);
  postPrices(vm, s);
  vm.must(deposit(vm, s, s.alice, 1_000_000_000n));
  vm.must(keeperSwap(vm, s, s.keeper, USDC_LEG, 0, 500_000_000n));
  failsWith(send(vm, s, [setPausedIx(vm.vault(s.indexId), s.keeper.publicKey, true)], s.keeper), "ConstraintHasOne");
  vm.must(send(vm, s, [setPausedIx(vm.vault(s.indexId), s.admin.publicKey, true)], s.admin), "pause");
  const v = vm.vault(s.indexId);
  failsWith(deposit(vm, s, s.alice, 10_000_000n), "Paused");
  failsWith(send(vm, s, [withdrawIx(v, s.alice.publicKey, 1_000_000n, 0n)], s.alice), "Paused");
  failsWith(keeperSwap(vm, s, s.keeper, USDC_LEG, 0, 10_000_000n), "Paused");
  const r = request(vm, s, s.alice, 10_000_000n);
  vm.must(r.result, "request while paused");
  failsWith(send(vm, s, [crossRequestLegIx(v, s.keeper.publicKey, r.address, 0)], s.keeper), "Paused");
  ownerAtas(vm, s, s.alice);
  const legABefore = vm.balance(ata(s.alice.publicKey, s.legA));
  vm.must(send(vm, s, [claimInKindIx(v, s.alice.publicKey, { address: r.address, owner: s.alice.publicKey }, [0, 1])], s.alice), "claim while paused");
  assert.ok(vm.balance(ata(s.alice.publicKey, s.legA)) > legABefore);
});

test("admin refund: admin burns a holder's shares into an in-kind request paid only to that holder", () => {
  const vm = navVaultVm();
  const s = seedIndex(vm);
  postPrices(vm, s);
  vm.must(deposit(vm, s, s.alice, 1_000_000_000n));
  vm.must(keeperSwap(vm, s, s.keeper, USDC_LEG, 0, 500_000_000n));
  const v = vm.vault(s.indexId);
  failsWith(send(vm, s, [adminRedeemInKindIx(v, s.bob.publicKey, s.alice.publicKey, 1_000_000n, 1n)], s.bob), "ConstraintHasOne");
  const shares = sharesOf(vm, s, s.alice);
  vm.must(send(vm, s, [adminRedeemInKindIx(v, s.admin.publicKey, s.alice.publicKey, shares, 7n)], s.admin), "admin redeem");
  assert.equal(sharesOf(vm, s, s.alice), 0n, "permanent-delegate burn");
  const address = requestPda(v.address, s.alice.publicKey, 7n);
  const req = decodeRequest(address, vm.info(address)!.data);
  assert.equal(req.owner.toBase58(), s.alice.publicKey.toBase58());
  assert.equal(req.adminForced, true);
  // The admin cannot redirect the payout to itself.
  ownerAtas(vm, s, s.admin);
  const redirect = claimInKindIx(v, s.admin.publicKey, { address, owner: s.alice.publicKey }, [0]);
  redirect.keys[9 + 2]!.pubkey = ata(s.admin.publicKey, v.legs[0]!.mint); // owner leg account → admin's
  failsWith(send(vm, s, [redirect], s.admin), "UserAccountMismatch");
  ownerAtas(vm, s, s.alice);
  vm.must(send(vm, s, [claimInKindIx(v, s.admin.publicKey, { address, owner: s.alice.publicKey }, [0, 1])], s.admin), "admin pays the holder");
  assert.equal(vm.balance(ata(s.alice.publicKey, s.legA)), req.legAmounts[0]);
  assert.equal(vm.info(address), null);
});

test("25 legs: deposit, marks, keeper swap, request, instant withdraw and a chunked in-kind claim all fit the 64-account cap", () => {
  const vm = navVaultVm();
  const s = seedIndex(vm, "idx-test-25", { legCount: 25 });
  assert.equal(vm.vault(s.indexId).legs.length, 25);
  postPrices(vm, s);
  vm.must(deposit(vm, s, s.alice, 2_000_000_000n), "deposit (25 leg NAV reads)");
  vm.must(deposit(vm, s, s.bob, 2_000_000_000n), "second deposit");
  for (const leg of [0, 1, 24]) vm.must(keeperSwap(vm, s, s.keeper, USDC_LEG, leg, 100_000_000n), `buy leg ${leg}`);
  postPrices(vm, s);
  const v = vm.vault(s.indexId);
  ownerAtas(vm, s, s.alice);
  vm.must(send(vm, s, [withdrawIx(v, s.alice.publicKey, 10_000_000n, 0n)], s.alice), "instant withdraw (25 legs)");
  const r = request(vm, s, s.alice, 500_000_000n, { inKindNow: true });
  vm.must(r.result, "request (25 legs)");
  const legs = Array.from({ length: 25 }, (_, i) => i);
  assert.equal(CLAIM_LEGS_PER_TX, 13);
  vm.must(send(vm, s, [claimInKindIx(v, s.alice.publicKey, { address: r.address, owner: s.alice.publicKey }, legs.slice(0, 13))], s.alice), "claim chunk 1");
  assert.ok(vm.info(r.address), "request stays open between chunks");
  vm.must(send(vm, s, [claimInKindIx(v, s.alice.publicKey, { address: r.address, owner: s.alice.publicKey }, legs.slice(13))], s.alice), "claim chunk 2");
  assert.equal(vm.info(r.address), null);
  assert.ok(vm.balance(ata(s.alice.publicKey, v.legs[24]!.mint, v.legs[24]!.tokenProgram)) > 0n);
});

test("keeper cycle nets deposits and withdrawals: crosses first, at most one swap per leg, then settles", async () => {
  const vm = navVaultVm();
  const s = seedIndex(vm);
  postPrices(vm, s);
  vm.must(deposit(vm, s, s.alice, 1_000_000_000n));
  vm.must(keeperSwap(vm, s, s.keeper, USDC_LEG, 0, 560_000_000n));
  vm.must(keeperSwap(vm, s, s.keeper, USDC_LEG, 1, 370_000_000n));
  // Same cycle: bob deposits (needs buys) and alice requests a large exit (needs sells).
  vm.must(deposit(vm, s, s.bob, 1_000_000_000n));
  const r = request(vm, s, s.alice, 300_000_000n);
  vm.must(r.result);
  ownerAtas(vm, s, s.alice);
  const venue = mockVenue(vm.connection, s.usdc);
  const nowSeconds = () => Number(vm.svm.getClock().unixTimestamp);
  const execute = async (tx: VersionedTransaction) => { tx.sign([s.keeper]); vm.must(vm.sendRaw(tx.serialize()), "keeper tx"); return "local"; };
  const dry = await keeperTick({ connection: vm.connection, indexId: s.indexId, keeper: s.keeper.publicKey, ...venue, nowSeconds });
  assert.equal(dry.requests.open, 1);
  assert.ok(dry.plan.some(p => p.kind === "cross"), "exit netted against bob's fresh USDC");
  const snapshotPlan = planCycle({ snapshot: { ...(await import("../src/lib/nav-vault/prepare.ts").then(m => m.readNavVault(vm.connection, s.indexId, undefined, nowSeconds())))! }, requests: await readNavRequests(vm.connection, vm.vault(s.indexId).address) });
  const perLeg = new Map<number, number>();
  for (const a of snapshotPlan.swaps) perLeg.set(a.leg, (perLeg.get(a.leg) ?? 0) + 1);
  assert.ok([...perLeg.values()].every(n => n <= 1), "at most one swap per leg per cycle");
  const usdcBefore = vm.balance(ata(s.alice.publicKey, s.usdc));
  const tick = await keeperTick({ connection: vm.connection, indexId: s.indexId, keeper: s.keeper.publicKey, ...venue, execute, afterPrices: async () => vm.advance(1), nowSeconds });
  assert.equal(tick.requests.settled, 1, "request settled in USDC this cycle");
  const swapSteps = tick.signatures.filter(x => /^(buy|sell|fulfill):/.test(x.step)).map(x => x.step.split(":")[1]);
  assert.equal(new Set(swapSteps).size, swapSteps.length, "one swap per leg");
  assert.ok(vm.balance(ata(s.alice.publicKey, s.usdc)) > usdcBefore);
  assert.equal(vm.info(r.address), null);
  const after = navOf(vm, s);
  assert.ok(after.freeUsdc * 10_000n >= after.nav * 500n, "buffer floor held after netting");
});

test("prepare returns exactly ONE transaction each way (deposit, instant USDC, keeper request, in-kind) and they execute", async () => {
  const vm = navVaultVm();
  const s = seedIndex(vm);
  postPrices(vm, s);
  const nowSeconds = Number(vm.svm.getClock().unixTimestamp);
  const sign = (b64: string, who: Keypair) => { const tx = VersionedTransaction.deserialize(Buffer.from(b64, "base64")); tx.sign([who]); return tx.serialize(); };
  const common = { connection: vm.connection, network: "devnet" as const, indexId: s.indexId, owner: s.alice.publicKey.toBase58(), nowSeconds };
  const dep = await prepareNavDeposit({ ...common, amountRaw: "1000000000" });
  assert.equal(dep.transactions.length, 1);
  assert.equal(dep.navVault.feeRaw, "2500000");
  vm.must(vm.sendRaw(sign(dep.transactions[0]!.messageBase64, s.alice)), "prepared deposit");
  assert.equal(sharesOf(vm, s, s.alice).toString(), dep.estimate.sharesRaw);
  const usdcExit = await prepareNavWithdraw({ ...common, shareAmountRaw: "10000000" });
  assert.equal(usdcExit.transactions.length, 1);
  assert.equal(usdcExit.navVault.path, "usdc");
  vm.must(vm.sendRaw(sign(usdcExit.transactions[0]!.messageBase64, s.alice)), "prepared USDC exit");
  vm.must(keeperSwap(vm, s, s.keeper, USDC_LEG, 0, 550_000_000n));
  vm.must(keeperSwap(vm, s, s.keeper, USDC_LEG, 1, 380_000_000n));
  const req = await prepareNavWithdraw({ ...common, shareAmountRaw: "400000000" });
  assert.equal(req.transactions.length, 1);
  assert.equal(req.navVault.path, "request");
  vm.must(vm.sendRaw(sign(req.transactions[0]!.messageBase64, s.alice)), "prepared keeper request");
  assert.ok(vm.info(new PublicKey(req.navVault.request!)));
  const rest = sharesOf(vm, s, s.alice).toString();
  const inKind = await prepareNavWithdraw({ ...common, shareAmountRaw: rest, inKind: true });
  assert.equal(inKind.transactions.length, 1);
  assert.equal(inKind.navVault.path, "in-kind");
  assert.match(inKind.estimate.outputSummary, /not a USDC exit/);
  vm.must(vm.sendRaw(sign(inKind.transactions[0]!.messageBase64, s.alice)), "prepared in-kind exit (request + claim in one tx)");
  assert.equal(vm.info(new PublicKey(inKind.navVault.request!)), null);
  assert.ok(vm.balance(ata(s.alice.publicKey, s.legA)) > 0n && vm.balance(ata(s.alice.publicKey, s.legB, TOKEN_2022_PROGRAM_ID)) > 0n);
});

test("per-deposit cap: above-cap deposits refuse on chain; only the admin can change it", () => {
  const vm = navVaultVm();
  const s = seedIndex(vm);
  postPrices(vm, s);
  const v = vm.vault(s.indexId);
  failsWith(send(vm, s, [setMaxDepositIx(v, s.alice.publicKey, 1n)], s.alice), "ConstraintHasOne");
  vm.must(send(vm, s, [setMaxDepositIx(v, s.admin.publicKey, 50_000_000n)], s.admin));
  failsWith(deposit(vm, s, s.alice, 50_000_001n), "DepositAboveCap");
  vm.must(deposit(vm, s, s.alice, 50_000_000n));
});

test("planRebalance buys toward weights down to the 5% buffer and sells the most overweight leg when short", () => {
  const legs = [{ weightBps: 6000, price: PRICE_A, decimals: 6 }, { weightBps: 4000, price: PRICE_B, decimals: 8 }];
  const buys = planRebalance({ legs, usdc: 1_000_000_000n, legBalances: [0n, 0n], bufferBps: 500 });
  assert.deepEqual(buys.map(a => [a.kind, a.leg, a.amountInRaw]), [["buy", 0, 567_000_000n], ["buy", 1, 378_000_000n]]);
  const sells = planRebalance({ legs, usdc: 10_000_000n, legBalances: [3_000_000n, 100_000_000n], bufferBps: 500 });
  assert.equal(sells[0]!.kind, "sell");
  assert.equal(sells[0]!.leg, 0);
  assert.equal(markFromQuote(100_000_000n, 500_000n, 6), PRICE_A);
});

export type { NavVaultState };

test("admin can raise the max mark age (e.g. 60s → 120s); nobody else can", () => {
  const vm = navVaultVm();
  const s = seedIndex(vm);
  postPrices(vm, s);
  const v = vm.vault(s.indexId);
  failsWith(send(vm, s, [setMaxPriceAgeIx(v, s.keeper.publicKey, 120)], s.keeper), "ConstraintHasOne");
  failsWith(send(vm, s, [setMaxPriceAgeIx(v, s.admin.publicKey, 0)], s.admin), "InvalidConfig");
  vm.advance(301);
  failsWith(deposit(vm, s, s.alice, 10_000_000n), "StalePrices");
  vm.must(send(vm, s, [setMaxPriceAgeIx(v, s.admin.publicKey, 600)], s.admin), "admin raises max age");
  assert.equal(vm.vault(s.indexId).maxPriceAgeSecs, 600);
  vm.must(deposit(vm, s, s.alice, 10_000_000n), "deposit with a 301 s old mark under the raised age");
});

test("one keeper cycles many vaults: marks quoted once per mint, prices batched into few transactions, each vault rebalanced", async () => {
  const { keeperCycleAll } = await import("../src/lib/nav-vault/keeper.ts");
  const vm = navVaultVm();
  const a = seedIndex(vm, "idx-test-a");
  const b = seedIndex(vm, "idx-test-b", { keeper: a.keeper });
  postPrices(vm, a);
  postPrices(vm, b);
  vm.must(deposit(vm, a, a.alice, 500_000_000n));
  vm.must(deposit(vm, b, b.alice, 300_000_000n));
  const venueA = mockVenue(vm.connection, a.usdc), venueB = mockVenue(vm.connection, b.usdc);
  const byMint = new Map([...a.legs, ...b.legs].map((leg, i) => [leg.mint.toBase58(), i < 2 ? venueA : venueB]));
  let quotes = 0;
  const marks = async (leg: Parameters<typeof venueA.marks>[0]) => { quotes += 1; return byMint.get(leg.mint.toBase58())!.marks(leg); };
  const swaps = async (input: Parameters<typeof venueA.swaps>[0]) => (input.inMint.equals(a.usdc) || input.outMint.equals(a.usdc) ? venueA : venueB).swaps(input);
  const sent: string[] = [];
  const execute = async (tx: VersionedTransaction, step: string) => { tx.sign([a.keeper]); vm.must(vm.sendRaw(tx.serialize()), step); sent.push(step); return step; };
  const cycle = await keeperCycleAll({ connection: vm.connection, indexIds: ["idx-test-a", "idx-test-b", "idx-missing"], keeper: a.keeper.publicKey, marks, swaps, execute, afterPrices: async () => vm.advance(1), nowSeconds: () => Number(vm.svm.getClock().unixTimestamp) });
  assert.equal(quotes, 4, "each mint quoted once per cycle");
  assert.equal(cycle.priceTransactions.length, 1, "both vaults' marks posted in ONE transaction");
  assert.deepEqual(cycle.vaults.filter(v => !v.ok).map(v => v.indexId), ["idx-missing"]);
  for (const s of [a, b]) {
    const state = navOf(vm, s);
    assert.ok(state.legs.every(x => x > 0n), `${s.indexId} holds every leg`);
    assert.ok(state.freeUsdc * 10_000n >= state.nav * 500n);
  }
  assert.ok(!sent.some(step => step === "update_prices"), "no per-vault price re-post");
});

test("independent mark loop: postMarksAll posts every vault's marks alone; the trading cycle then trades on posted marks without quoting", async () => {
  const { keeperCycleAll, postMarksAll } = await import("../src/lib/nav-vault/keeper.ts");
  const vm = navVaultVm();
  const a = seedIndex(vm, "idx-test-a");
  const b = seedIndex(vm, "idx-test-b", { keeper: a.keeper });
  postPrices(vm, a);
  postPrices(vm, b);
  vm.must(deposit(vm, a, a.alice, 500_000_000n));
  vm.must(deposit(vm, b, b.alice, 300_000_000n));
  const venueA = mockVenue(vm.connection, a.usdc), venueB = mockVenue(vm.connection, b.usdc);
  const byMint = new Map([...a.legs, ...b.legs].map((leg, i) => [leg.mint.toBase58(), i < 2 ? venueA : venueB]));
  let quotes = 0;
  const marks = async (leg: Parameters<typeof venueA.marks>[0]) => { quotes += 1; return byMint.get(leg.mint.toBase58())!.marks(leg); };
  const swaps = async (input: Parameters<typeof venueA.swaps>[0]) => (input.inMint.equals(a.usdc) || input.outMint.equals(a.usdc) ? venueA : venueB).swaps(input);
  const sent: string[] = [];
  const execute = async (tx: VersionedTransaction, step: string) => { tx.sign([a.keeper]); vm.must(vm.sendRaw(tx.serialize()), step); sent.push(step); return step; };
  const nowSeconds = () => Number(vm.svm.getClock().unixTimestamp);
  vm.advance(100);
  const posted = await postMarksAll({ connection: vm.connection, indexIds: ["idx-test-a", "idx-test-b"], keeper: a.keeper.publicKey, marks, execute, nowSeconds });
  assert.equal(quotes, 4, "each mint quoted once");
  assert.equal(posted.priceTransactions.length, 1);
  assert.ok(sent.every(step => step.startsWith("update_prices")), "the mark loop sends nothing but price posts");
  assert.equal(Number(vm.vault("idx-test-a").pricesUpdatedAt), nowSeconds(), "marks refreshed on chain");
  vm.advance(1);
  sent.length = 0;
  const cycle = await keeperCycleAll({ connection: vm.connection, indexIds: ["idx-test-a", "idx-test-b"], keeper: a.keeper.publicKey, marks, swaps, execute, nowSeconds, marksPosted: true });
  assert.equal(quotes, 4, "the trading cycle does not quote marks");
  assert.equal(cycle.priceTransactions.length, 0, "nor post them");
  assert.ok(sent.some(step => /^buy:/.test(step)), "it still rebalances on the posted marks");
  for (const s of [a, b]) assert.ok(navOf(vm, s).legs.every(x => x > 0n), `${s.indexId} holds every leg`);
  // Posted marks gone stale: the trading cycle skips the vaults instead of trading on them.
  vm.advance(400);
  const stale = await keeperCycleAll({ connection: vm.connection, indexIds: ["idx-test-a"], keeper: a.keeper.publicKey, marks, swaps, execute, nowSeconds, marksPosted: true });
  assert.match(stale.vaults[0]!.error ?? "", /stale/);
});

/** Ask-side marks: posted 3% above the venue price, so a sale at the venue misses the 1% on-chain bound. */
function askPremiumVenue(vm: NavVm, s: Seeded, options: { staleQuote?: boolean } = {}) {
  const venue = mockVenue(vm.connection, s.usdc);
  return {
    marks: async (leg: Parameters<typeof venue.marks>[0]) => { const m = await venue.marks(leg); return { price: m.price * 103n / 100n, venue: "ask" }; },
    // staleQuote: an optimistic quote passes the keeper pre-check, so only the on-chain SwapPriceBound refuses the sale.
    swaps: async (input: Parameters<typeof venue.swaps>[0]) => { const built = await venue.swaps(input); return built && options.staleQuote ? { ...built, expectedOut: built.expectedOut! * 110n / 100n } : built; },
  };
}

test("an unsellable rebalance sell is deferred, never aborts the cycle: the converted cash-out still settles", async () => {
  for (const staleQuote of [false, true]) {
    const vm = navVaultVm();
    const s = seedIndex(vm);
    postPrices(vm, s);
    vm.must(deposit(vm, s, s.alice, 1_000_000_000n));
    vm.must(keeperSwap(vm, s, s.keeper, USDC_LEG, 0, 560_000_000n));
    vm.must(keeperSwap(vm, s, s.keeper, USDC_LEG, 1, 370_000_000n));
    vm.must(deposit(vm, s, s.bob, 100_000_000n));
    const r = request(vm, s, s.alice, 150_000_000n);
    vm.must(r.result);
    const nowSeconds = () => Number(vm.svm.getClock().unixTimestamp);
    const execute = async (tx: VersionedTransaction, step: string) => { tx.sign([s.keeper]); vm.must(vm.sendRaw(tx.serialize()), step); return step; };
    const deferrals = new Map();
    const usdcBefore = vm.balance(ata(s.alice.publicKey, s.usdc));
    const tick = await keeperTick({ connection: vm.connection, indexId: s.indexId, keeper: s.keeper.publicKey, ...askPremiumVenue(vm, s, { staleQuote }), execute, afterPrices: async () => vm.advance(1), nowSeconds, deferrals });
    assert.equal(tick.requests.crosses, 2, "exit netted against free USDC");
    assert.ok(tick.plan.some(p => p.kind === "sell"), "buffer below floor → planned a top-up sell");
    assert.ok(!tick.signatures.some(x => x.step.startsWith("sell:")), "the sale did not land");
    const skipped = tick.skipped.find(x => x.step === "sell");
    assert.ok(skipped?.retryAt && skipped.retryAt > nowSeconds(), `sell deferred with a retry time (${staleQuote ? "on-chain bound" : "quote pre-check"})`);
    assert.match(skipped!.reason, staleQuote ? /SwapPriceBound|0x1788/ : /posted-price bound/);
    assert.equal(tick.requests.settled, 1, "settle ran after the failed sell");
    assert.ok(vm.balance(ata(s.alice.publicKey, s.usdc)) > usdcBefore);
    assert.equal(vm.info(r.address), null);
    // Next cycle: the deferred leg is not retried; the next overweight leg is tried instead.
    const soldLeg = tick.plan.find(p => p.kind === "sell")!.mint;
    vm.advance(5);
    const next = await keeperTick({ connection: vm.connection, indexId: s.indexId, keeper: s.keeper.publicKey, ...askPremiumVenue(vm, s, { staleQuote }), nowSeconds, deferrals });
    assert.ok(!next.plan.some(p => p.kind === "sell" && p.mint === soldLeg), "deferred leg skipped next cycle");
    assert.ok(next.skipped.some(x => x.mint === soldLeg && x.step === "sell (deferred)"));
  }
});

test("an unsellable request slice keeps retrying to USDC until the timeout, then goes in kind only into accounts the owner already has", async () => {
  const vm = navVaultVm();
  const s = seedIndex(vm, "idx-test-nav", { requestTimeoutSecs: 120 });
  postPrices(vm, s);
  vm.must(deposit(vm, s, s.alice, 1_000_000_000n));
  vm.must(keeperSwap(vm, s, s.keeper, USDC_LEG, 0, 560_000_000n));
  vm.must(keeperSwap(vm, s, s.keeper, USDC_LEG, 1, 370_000_000n));
  const r = request(vm, s, s.alice, 600_000_000n);
  vm.must(r.result);
  const carved = r.read();
  assert.ok(carved.legAmounts.every(a => a > 0n));
  const v = vm.vault(s.indexId);
  const legAta = (i: number) => ata(s.alice.publicKey, v.legs[i]!.mint, v.legs[i]!.tokenProgram);
  assert.equal(vm.info(legAta(1)), null, "owner has no stock accounts yet");
  const nowSeconds = () => Number(vm.svm.getClock().unixTimestamp);
  const execute = async (tx: VersionedTransaction, step: string) => { tx.sign([s.keeper]); vm.must(vm.sendRaw(tx.serialize()), step); return step; };
  const deferrals = new Map();
  const tick = async () => { postPrices(vm, s); return keeperTick({ connection: vm.connection, indexId: s.indexId, keeper: s.keeper.publicKey, ...askPremiumVenue(vm, s), execute, afterPrices: async () => vm.advance(1), nowSeconds, deferrals }); };
  const first = await tick();
  assert.equal(first.requests.fulfills, 0);
  assert.equal(first.requests.deliveredInKind, 0, "no in-kind delivery before the timeout: the cash-out promises USDC first");
  assert.ok(vm.info(r.address), "request still open");
  assert.ok([...deferrals.keys()].every(k => k.startsWith("fulfill:")) && [...deferrals.values()].every(d => d.until - nowSeconds() <= 31), "request slices retry on a short backoff");
  vm.advance(125);
  const timedOut = await tick();
  assert.equal(timedOut.requests.deliveredInKind, 0, "the keeper never creates (pays rent for) owner accounts");
  assert.equal(vm.info(legAta(0)), null);
  assert.equal(vm.info(legAta(1)), null);
  assert.ok(vm.info(r.address), "the request stays claimable by its owner");
  ownerAtas(vm, s, s.alice);
  const usdcBefore = vm.balance(ata(s.alice.publicKey, s.usdc));
  vm.advance(5);
  const delivered = await tick();
  assert.equal(delivered.requests.deliveredInKind, 2, "both still-unsellable legs delivered into the owner's existing accounts");
  assert.equal(vm.info(r.address), null, "request closed");
  assert.equal(vm.balance(legAta(0)), carved.legAmounts[0]);
  assert.equal(vm.balance(legAta(1)), carved.legAmounts[1]);
  assert.equal(vm.balance(ata(s.alice.publicKey, s.usdc)) - usdcBefore, carved.usdcOwed, "carved USDC paid with the stock");
  const after = navOf(vm, s);
  assert.equal(after.v.reservedUsdc, 0n);
  assert.ok(after.v.legs.every(l => l.reserved === 0n));
});

test("a transiently failing fulfil is retried later, and delivered in kind once the request times out", async () => {
  const vm = navVaultVm();
  const s = seedIndex(vm, "idx-test-nav", { requestTimeoutSecs: 60 });
  postPrices(vm, s);
  vm.must(deposit(vm, s, s.alice, 1_000_000_000n));
  vm.must(keeperSwap(vm, s, s.keeper, USDC_LEG, 0, 560_000_000n));
  vm.must(keeperSwap(vm, s, s.keeper, USDC_LEG, 1, 370_000_000n));
  const r = request(vm, s, s.alice, 600_000_000n);
  vm.must(r.result);
  const venue = mockVenue(vm.connection, s.usdc);
  const flaky = { marks: venue.marks, swaps: async () => { throw new Error("fetch failed: 503"); } };
  const nowSeconds = () => Number(vm.svm.getClock().unixTimestamp);
  const execute = async (tx: VersionedTransaction, step: string) => { tx.sign([s.keeper]); vm.must(vm.sendRaw(tx.serialize()), step); return step; };
  const deferrals = new Map();
  const first = await keeperTick({ connection: vm.connection, indexId: s.indexId, keeper: s.keeper.publicKey, ...flaky, execute, afterPrices: async () => vm.advance(1), nowSeconds, deferrals });
  assert.equal(first.requests.deliveredInKind, 0, "a transient failure is not an in-kind trigger before the timeout");
  assert.ok(vm.info(r.address));
  assert.ok([...deferrals.values()].every(d => !d.unsellable));
  vm.advance(61);
  ownerAtas(vm, s, s.alice);
  const second = await keeperTick({ connection: vm.connection, indexId: s.indexId, keeper: s.keeper.publicKey, ...flaky, execute, afterPrices: async () => vm.advance(1), nowSeconds, deferrals });
  assert.equal(second.requests.deliveredInKind, 2, "timed-out request with failing legs goes in kind");
  assert.equal(vm.info(r.address), null);
});

test("live QA fixes: marks headroom, stale exits refuse, priority fee, full exit closes the share account, 11-leg in-kind fits the trace limit", async () => {
  const { NAV_MARK_HEADROOM_SECS, NAV_STALE_PRICES, simulationMessage } = await import("../src/lib/nav-vault/prepare.ts");
  const vm = navVaultVm();
  const s = seedIndex(vm, "idx-test-11", { legCount: 11 });
  postPrices(vm, s);
  const sign = (b64: string, who: Keypair) => { const tx = VersionedTransaction.deserialize(Buffer.from(b64, "base64")); tx.sign([who]); return tx.serialize(); };
  const now = () => Number(vm.svm.getClock().unixTimestamp);
  const common = () => ({ connection: vm.connection, network: "devnet" as const, indexId: s.indexId, owner: s.alice.publicKey.toBase58(), nowSeconds: now() });
  const dep = await prepareNavDeposit({ ...common(), amountRaw: "1000000000" });
  const depTx = VersionedTransaction.deserialize(Buffer.from(dep.transactions[0]!.messageBase64, "base64"));
  const budget = ComputeBudgetProgram.programId.toBase58();
  const prices = depTx.message.compiledInstructions.filter(ix => depTx.message.staticAccountKeys[ix.programIdIndex]!.toBase58() === budget && ix.data[0] === 3);
  assert.equal(prices.length, 1, "user transactions carry a compute-unit price (B2)");
  vm.must(vm.sendRaw(sign(dep.transactions[0]!.messageBase64, s.alice)), "prepared deposit");
  for (const leg of [0, 1, 5, 10]) vm.must(keeperSwap(vm, s, s.keeper, USDC_LEG, leg, 80_000_000n), `buy leg ${leg}`);
  postPrices(vm, s);
  // Marks still valid on chain but inside the headroom window: deposit and USDC exit refuse (B3, B6).
  const maxAge = vm.vault(s.indexId).maxPriceAgeSecs;
  vm.advance(maxAge - NAV_MARK_HEADROOM_SECS + 2);
  await assert.rejects(prepareNavDeposit({ ...common(), amountRaw: "1000000" }), new RegExp(NAV_STALE_PRICES.slice(0, 20)));
  const shares = sharesOf(vm, s, s.alice).toString();
  await assert.rejects(prepareNavWithdraw({ ...common(), shareAmountRaw: shares }), new RegExp(NAV_STALE_PRICES.slice(0, 20)), "no silent in-kind exit on stale marks");
  // An explicit in-kind full exit on 11 legs: missing owner accounts are created first, then request + claim + close (B5, B10).
  const inKind = await prepareNavWithdraw({ ...common(), shareAmountRaw: shares, inKind: true });
  assert.equal(inKind.navVault.path, "in-kind");
  assert.ok(inKind.transactions.length > 1, "owner accounts move to setup transactions");
  // The VM expires the blockhash after every send; on chain these share one blockhash, signed in order.
  const fresh = (b64: string) => { const tx = VersionedTransaction.deserialize(Buffer.from(b64, "base64")); tx.message.recentBlockhash = vm.svm.latestBlockhash(); tx.sign([s.alice]); return tx.serialize(); };
  for (const [i, tx] of inKind.transactions.entries()) vm.must(vm.sendRaw(fresh(tx.messageBase64)), `in-kind transaction ${i + 1}`);
  assert.equal(vm.info(new PublicKey(inKind.navVault.request!)), null, "request fully claimed");
  assert.equal(vm.info(shareAta(s.alice.publicKey, vm.vault(s.indexId).shareMint)), null, "emptied share account closed");
  const v = vm.vault(s.indexId);
  for (const leg of [0, 1, 5, 10]) assert.ok(vm.balance(ata(s.alice.publicKey, v.legs[leg]!.mint, v.legs[leg]!.tokenProgram)) > 0n, `leg ${leg} delivered`);
  // A fee payer with no SOL fails with no logs: the wallet-funds message, not the generic one (B1).
  assert.equal(simulationMessage([], "AccountNotFound"), "This wallet does not have enough USDC or SOL.");
  assert.equal(simulationMessage([], { InstructionError: [0, "InvalidAccountData"] }), "The vault transaction did not simulate.");
});
