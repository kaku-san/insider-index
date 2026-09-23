import assert from "node:assert/strict";
import test from "node:test";
import BN from "bn.js";
import { register } from "node:module";
import { PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, createSyncNativeInstruction, NATIVE_MINT, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { createRebalanceIntentIx, initRebalanceIntentIx, resizeRebalanceIntentIx } from "@symmetry-hq/sdk/dist/instructions/automation/rebalanceIntent.js";
import { getAta, getGlobalConfigPda, getRebalanceIntentPda, getRentPayerPda } from "@symmetry-hq/sdk/dist/instructions/pda.js";
import { networkUsdc, SYMMETRY_PROGRAM_ID } from "../src/lib/index-vaults/symmetry-adapter.ts";

register("./support/ui-loader.mjs", import.meta.url);
const { handleIndexDepositPrepare, parseIndexDepositRequest } = await import("../src/lib/index-vaults/index-deposit.ts");
const { MAG7_UNROUTABLE_AMOUNT } = await import("../src/lib/index-vaults/mag7-deposit-slices.ts");

const owner = "Jh7cFNUT5FrtBwKakApsc3Gg5aTQjsZtYxa4dbrCoB8";
const vault = "AwDFvjEPPwdF1YgXV8asNt6LeEFDduinYneCn6mHDAsh";
const shareMint = "9ihGfswnUZ6MysSR3KgmrZ57FXDVAiAQ6sEHwLuWwzJ4";
const DEPOSIT_RAW = "10000000";
const investmentMints = Array.from({ length: 7 }, () => PublicKey.unique());

function transaction(instructions: TransactionInstruction[]) {
  const message = new TransactionMessage({ payerKey: new PublicKey(owner), recentBlockhash: owner, instructions }).compileToV0Message();
  const signed = new VersionedTransaction(message);
  return {
    tx_b64: Buffer.from(signed.serialize()).toString("base64"), message_version: "0" as const, recent_blockhash: owner,
    last_valid_block_height: 99, payer: owner, lookup_tables: [],
    instructions: instructions.map(instruction => ({ program_id: instruction.programId.toBase58(), accounts: instruction.keys.map(account => ({ pubkey: account.pubkey.toBase58(), is_signer: account.isSigner, is_writable: account.isWritable })), data: instruction.data.toString("base64") })),
  };
}

function payload(kind: "deposit" | "lock") {
  const buyer = new PublicKey(owner);
  const vaultKey = new PublicKey(vault);
  const usdc = new PublicKey(networkUsdc("mainnet-beta"));
  const intent = getRebalanceIntentPda(vaultKey, buyer);
  const instruction = kind === "deposit"
    ? new TransactionInstruction({
        programId: new PublicKey(SYMMETRY_PROGRAM_ID),
        keys: [
          { pubkey: buyer, isSigner: true, isWritable: true }, { pubkey: vaultKey, isSigner: false, isWritable: true }, { pubkey: intent, isSigner: false, isWritable: true },
          { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }, { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false }, { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }, { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          { pubkey: usdc, isSigner: false, isWritable: false }, { pubkey: getAta(buyer, usdc, TOKEN_PROGRAM_ID), isSigner: false, isWritable: true }, { pubkey: getAta(vaultKey, usdc, TOKEN_PROGRAM_ID), isSigner: false, isWritable: true },
        ],
        data: Buffer.concat([Buffer.from([88, 92, 158, 219, 83, 71, 239, 164]), Buffer.alloc(80)]),
      })
    : new TransactionInstruction({
        programId: new PublicKey(SYMMETRY_PROGRAM_ID),
        keys: [{ pubkey: buyer, isSigner: true, isWritable: true }, { pubkey: intent, isSigner: false, isWritable: true }, { pubkey: getGlobalConfigPda(), isSigner: false, isWritable: false }],
        data: Buffer.from([64, 238, 171, 198, 135, 253, 37, 9]),
      });
  if (kind === "deposit") instruction.data.writeBigUInt64LE(BigInt(DEPOSIT_RAW), 8);
  return { batches: [{ transactions: [transaction([instruction])] }] };
}

function firstDepositPayloadWithAncillaryCreates() {
  const buyer = new PublicKey(owner);
  const vaultKey = new PublicKey(vault);
  const bountyMint = NATIVE_MINT;
  const intent = getRebalanceIntentPda(vaultKey, buyer);
  const setup = [
    createAssociatedTokenAccountIdempotentInstruction(buyer, getAta(buyer, new PublicKey(shareMint), TOKEN_PROGRAM_ID), buyer, new PublicKey(shareMint)),
    createAssociatedTokenAccountIdempotentInstruction(buyer, getAta(buyer, bountyMint, TOKEN_PROGRAM_ID), buyer, bountyMint),
    SystemProgram.transfer({ fromPubkey: buyer, toPubkey: getAta(buyer, bountyMint, TOKEN_PROGRAM_ID), lamports: 1 }),
    createSyncNativeInstruction(getAta(buyer, bountyMint, TOKEN_PROGRAM_ID)),
    createRebalanceIntentIx({ signer: buyer, owner: buyer, vault: vaultKey }),
    resizeRebalanceIntentIx(intent),
    initRebalanceIntentIx({ signer: buyer, owner: buyer, vault: vaultKey, vaultTokenMint: new PublicKey(shareMint), rebalanceIntentRentPayer: getRentPayerPda(), bountyMint, rebalanceType: 0, rebalanceSlippageBps: 100, perTradeRebalanceSlippageBps: 50, executionStartTime: 0, minBountyAmount: 0, maxBountyAmount: 0, vaultRebalanceIntent: undefined }),
  ];
  return { batches: [{ transactions: [transaction(setup)] }, ...payload("deposit").batches] };
}

const definition = {
  indexId: "idx-theme-mag7-caucus", network: "mainnet-beta", name: "Mag7 Caucus", symbol: "IIMAG7", status: "CREATABLE",
  depositsEnabled: true, depositReason: null, bookSource: null, provenance: {}, vaultAddress: vault, shareMint,
  vaultLegs: investmentMints.map((mint, i) => ({ mint: mint.toBase58(), ticker: `LEG${i}`, targetWeightBps: i === 6 ? 1432 : 1428, decimals: 6, pool: PublicKey.unique().toBase58(), kind: "raydium_clmm" })), keeper: { pubkey: null, automationEnabled: false }, hostEntryFeeBps: 25, hostExitFeeBps: 0,
};
function dependencies(overrides: Record<string, unknown> = {}, buy = firstDepositPayloadWithAncillaryCreates(), bountyMint = NATIVE_MINT) {
  return {
    loadDefinition: async () => definition,
    nativeBuilder: () => ({
      network: "mainnet-beta",
      assertNetwork: async () => {},
      connection: {
        getAccountInfo: async () => null,
        getAddressLookupTable: async () => ({ value: null }),
        getBlockHeight: async () => 1,
        simulateTransaction: async () => ({ context: { slot: 1 }, value: { err: null, logs: [] } }),
      },
      sdk: {
        fetchVault: async () => ({ ownAddress: new PublicKey(vault), mint: new PublicKey(shareMint), settings: { bountyMint }, supplyOutstanding: new BN(0), composition: [], numTokens: 0 }),
        buyVaultTx: async () => buy, lockDepositsTx: async () => payload("lock"),
      },
    }),
    release: { publicFundsEnabled: true, publicInvestSign: true },
    assertSlicesRoutable: async () => {},
    quoteZap: undefined as undefined | (() => Promise<ReturnType<typeof quotedZap>>),
    readSwapDeltas: undefined as undefined | (() => Promise<{ acquiredRawByMint: Record<string, string>; usdcSpentRaw: string }>),
    ...overrides,
  };
}
function request(body: unknown) {
  return new Request(`http://localhost/api/indexes/${definition.indexId}/deposit/prepare`, { method: "POST", body: JSON.stringify(body) });
}
function quotedZap() {
  const swapProgram = PublicKey.unique();
  const slices = definition.vaultLegs.map((leg, index) => {
    const message = new TransactionMessage({ payerKey: new PublicKey(owner), recentBlockhash: owner, instructions: [new TransactionInstruction({ programId: swapProgram, keys: [], data: Buffer.from([index + 1]) })] }).compileToV0Message();
    const tx = new VersionedTransaction(message);
    return {
      mint: leg.mint, ticker: leg.ticker, venue: "jupiter" as const, usdcInRaw: "1428000", expectedOutRaw: "5", minOutRaw: "4",
      swapProgramId: swapProgram.toBase58(), txBase64: Buffer.from(tx.serialize()).toString("base64"), recentBlockhash: owner, lastValidBlockHeight: 99,
    };
  });
  return {
    plan: {
      legCount: 7, packaging: "resumable" as const, leftoverUsdcRaw: "4000", keeperUsdcRaw: "0" as const, usesAuctionPairs: false as const,
      slices: slices.map(slice => ({ mint: slice.mint, ticker: slice.ticker, targetWeightBps: 1428, usdcInRaw: slice.usdcInRaw })),
      quotes: slices.map(slice => ({ mint: slice.mint, ticker: slice.ticker, venue: slice.venue, usdcInRaw: slice.usdcInRaw, expectedOutRaw: slice.expectedOutRaw, minOutRaw: slice.minOutRaw })),
    },
    slices,
  };
}

test("cash-only, partial, and zero-supply residual backing refuse before preparing another contribution", async () => {
  for (const [supply, count, cash] of [[2, 0, 3_000_000], [4, 2, 100], [0, 0, 3_000_000]]) {
    const deps = dependencies(), native = deps.nativeBuilder(), before = await native.sdk.fetchVault();
    native.sdk.fetchVault = async () => ({ ...before, supplyOutstanding: new BN(supply), numTokens: count + 1,
      composition: [...investmentMints.slice(0, count).map(mint => ({ mint, amount: new BN(100) })), { mint: new PublicKey(networkUsdc("mainnet-beta")), amount: new BN(cash) }] } as never);
    let contributions = 0;
    native.sdk.buyVaultTx = async () => { contributions++; throw new Error("must refuse before funding"); };
    deps.nativeBuilder = () => native;
    const response = await handleIndexDepositPrepare(request({ owner, amountRaw: DEPOSIT_RAW }), definition.indexId, deps as never);
    assert.equal(response.status, 503);
    assert.match((await response.json()).error, /reconcile/);
    assert.equal(contributions, 0);
  }
});

test("a fully backed seven-leg positive-supply vault passes the backing gate", async () => {
  const deps = dependencies(), native = deps.nativeBuilder(), before = await native.sdk.fetchVault();
  native.sdk.fetchVault = async () => ({ ...before, supplyOutstanding: new BN(99), numTokens: 7,
    composition: investmentMints.map(mint => ({ mint, amount: new BN(100) })) } as never);
  deps.nativeBuilder = () => native;
  deps.quoteZap = async () => quotedZap();
  const response = await handleIndexDepositPrepare(request({ owner, amountRaw: DEPOSIT_RAW }), definition.indexId, deps as never);
  assert.equal(response.status, 200);
});

test("deposit prepare quotes an in-kind Jupiter buy for every leg and does not lock USDC", async () => {
  let contributions = 0;
  const deps = dependencies({ quoteZap: async () => quotedZap() });
  const native = deps.nativeBuilder();
  native.sdk.buyVaultTx = async () => { contributions += 1; throw new Error("must not lock USDC before the basket is bought"); };
  deps.nativeBuilder = () => native;
  const response = await handleIndexDepositPrepare(request({ owner, amountRaw: DEPOSIT_RAW, idempotencyKey: "demo-1" }), definition.indexId, deps as never);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.requires, "user-signature");
  assert.equal(body.basket.stage, "acquire");
  assert.equal(body.basket.claimCount, null);
  assert.equal(body.basket.keeperUsdcRaw, "0");
  assert.equal(body.basket.usesAuctionPairs, false);
  assert.equal(body.transactions.length, 7);
  assert.equal(body.transactions[0].maxDebits[0].owner, owner);
  assert.equal(body.transactions[0].maxDebits[0].mint, networkUsdc("mainnet-beta"));
  assert.notEqual(body.transactions[0].maxDebits[0].amountRaw, DEPOSIT_RAW);
  assert.equal(body.transactions[0].expectedRecipients[0].owner, owner);
  const preparedTransaction = VersionedTransaction.deserialize(Buffer.from(body.transactions[0].messageBase64, "base64"));
  assert.ok(preparedTransaction.signatures.every(signature => signature.every(byte => byte === 0)));
  assert.equal(contributions, 0);
  assert.doesNotMatch(JSON.stringify(body), /getSwapPairs|keeper subsidy/i);
});

test("in-kind contribution still rejects an unknown ancillary program before spending", async () => {
  const randomProgram = PublicKey.unique();
  const invalid = firstDepositPayloadWithAncillaryCreates();
  invalid.batches[0]!.transactions[0]!.instructions.push({ program_id: randomProgram.toBase58(), accounts: [], data: "" });
  const deps = dependencies({}, invalid);
  deps.readSwapDeltas = async () => ({ acquiredRawByMint: Object.fromEntries(investmentMints.map(mint => [mint.toBase58(), "10"])), usdcSpentRaw: "9996000" });
  const response = await handleIndexDepositPrepare(request({ owner, amountRaw: DEPOSIT_RAW, stage: "contribute", signatures: ["1".repeat(88)] }), definition.indexId, deps as never);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "Unsupported ancillary instruction." });
});

test("deposit prepare rejects malformed amounts and every closed gate", async () => {
  assert.throws(() => parseIndexDepositRequest({ owner, amountRaw: "1", amountUsdc: "1" }), /either amountRaw/);
  assert.equal(parseIndexDepositRequest({ owner, amountUsdc: "10" }).amountRaw, DEPOSIT_RAW);
  assert.throws(() => parseIndexDepositRequest({ owner, amountUsdc: "9.999999" }), /Minimum is \$10/);
  const belowMinimum = await handleIndexDepositPrepare(request({ owner, amountRaw: "9999999" }), definition.indexId, dependencies() as never);
  assert.equal(belowMinimum.status, 400);
  assert.deepEqual(await belowMinimum.json(), { error: "Minimum is $10." });
  const closed = await handleIndexDepositPrepare(request({ owner, amountRaw: DEPOSIT_RAW }), definition.indexId, dependencies({ release: { publicFundsEnabled: false, publicInvestSign: true } }) as never);
  assert.equal(closed.status, 503);
  assert.deepEqual(await closed.json(), { error: "Investing is not open for signatures." });
  let nativeBuilderCalled = false;
  const paused = await handleIndexDepositPrepare(request({ owner, amountRaw: DEPOSIT_RAW }), definition.indexId, dependencies({
    release: { publicFundsEnabled: true, publicInvestSign: false },
    nativeBuilder: () => { nativeBuilderCalled = true; throw new Error("Deposit builder must not run while paused."); },
  }) as never);
  assert.equal(paused.status, 503);
  assert.equal(nativeBuilderCalled, false);
  assert.deepEqual(await paused.json(), { error: "Investing is not open for signatures." });
  const absent = await handleIndexDepositPrepare(request({ owner, amountRaw: DEPOSIT_RAW }), definition.indexId, dependencies({ loadDefinition: async () => null }) as never);
  assert.equal(absent.status, 503);
  assert.deepEqual(await absent.json(), { error: "Index not found." });
});

test("default Mag7 prepare refuses before buyVaultTx when Jupiter has no key", async () => {
  const MAG7_WEIGHTS = [3448, 2740, 1424, 1151, 854, 322, 61];
  let contributions = 0;
  const deps = dependencies({
    assertSlicesRoutable: undefined,
    env: {},
    loadDefinition: async () => ({ ...definition, vaultLegs: definition.vaultLegs.map((leg, i) => ({ ...leg, targetWeightBps: MAG7_WEIGHTS[i]! })) }),
  });
  const native = deps.nativeBuilder();
  native.sdk.buyVaultTx = async () => { contributions++; throw new Error("must refuse before funding"); };
  deps.nativeBuilder = () => native;
  const response = await handleIndexDepositPrepare(request({ owner, amountRaw: DEPOSIT_RAW }), definition.indexId, deps as never);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "Jupiter API key is required for index buys." });
  assert.equal(contributions, 0);
});

test("an unroutable Mag7 slice refuses before buyVaultTx and does not take USDC", async () => {
  let contributions = 0;
  const deps = dependencies({
    assertSlicesRoutable: async () => { throw new Error(MAG7_UNROUTABLE_AMOUNT); },
  });
  const native = deps.nativeBuilder();
  native.sdk.buyVaultTx = async () => { contributions++; throw new Error("must refuse before funding"); };
  deps.nativeBuilder = () => native;
  const response = await handleIndexDepositPrepare(request({ owner, amountRaw: DEPOSIT_RAW }), definition.indexId, deps as never);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: MAG7_UNROUTABLE_AMOUNT });
  assert.equal(contributions, 0);
});

test("Mag7 prepare quotes the requested size, not the $10 floor, before any buy", async () => {
  const quoted: string[] = [];
  const TWENTY_USDC = "20000000";
  let contributions = 0;
  const deps = dependencies({
    assertSlicesRoutable: async (_native: unknown, _definition: unknown, amountRaw: string) => {
      quoted.push(amountRaw);
      throw new Error(MAG7_UNROUTABLE_AMOUNT);
    },
  });
  const native = deps.nativeBuilder();
  native.sdk.buyVaultTx = async () => { contributions++; throw new Error("must refuse before funding"); };
  deps.nativeBuilder = () => native;
  const response = await handleIndexDepositPrepare(request({ owner, amountRaw: TWENTY_USDC }), definition.indexId, deps as never);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: MAG7_UNROUTABLE_AMOUNT });
  assert.deepEqual(quoted, [TWENTY_USDC]);
  assert.notEqual(quoted[0], DEPOSIT_RAW);
  assert.equal(contributions, 0);
});
