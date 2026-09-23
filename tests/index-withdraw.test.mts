import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { register } from "node:module";
import BN from "bn.js";
import { PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { createSyncNativeInstruction, NATIVE_MINT, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { createRebalanceIntentIx, initRebalanceIntentIx, resizeRebalanceIntentIx } from "@symmetry-hq/sdk/dist/instructions/automation/rebalanceIntent.js";
import { getAta, getRebalanceIntentPda, getRentPayerPda } from "@symmetry-hq/sdk/dist/instructions/pda.js";

register("./support/ui-loader.mjs", import.meta.url);
const { handleIndexWithdrawalPrepare, parseIndexWithdrawalRequest } = await import("../src/lib/index-vaults/index-withdraw.ts");

const owner = "8RZ4GrQDsctRGrW4tDZcYZRqFAW23eWkrVcJQ1DH7GyX";
const vault = "AwDFvjEPPwdF1YgXV8asNt6LeEFDduinYneCn6mHDAsh";
const shareMint = "9ihGfswnUZ6MysSR3KgmrZ57FXDVAiAQ6sEHwLuWwzJ4";
const stockMint = "So11111111111111111111111111111111111111112";

function auctionPayload(sharesRaw = "3", keep: { mask: BN; keepAll: number } = { mask: new BN(1), keepAll: 1 }, vaultAddress = vault, mintAddress = shareMint) {
  const seller = new PublicKey(owner), vaultKey = new PublicKey(vaultAddress), mint = new PublicKey(mintAddress);
  const intent = getRebalanceIntentPda(vaultKey, seller), bountyAta = getAta(seller, NATIVE_MINT, TOKEN_PROGRAM_ID);
  const instructions = [
    SystemProgram.transfer({ fromPubkey: seller, toPubkey: bountyAta, lamports: 1 }),
    createSyncNativeInstruction(bountyAta),
    createRebalanceIntentIx({ signer: seller, owner: seller, vault: vaultKey }),
    resizeRebalanceIntentIx(intent),
    initRebalanceIntentIx({
      signer: seller, owner: seller, vault: vaultKey, vaultTokenMint: mint, rebalanceIntentRentPayer: getRentPayerPda(), bountyMint: NATIVE_MINT,
      rebalanceType: 1, rebalanceSlippageBps: 100, perTradeRebalanceSlippageBps: 50, executionStartTime: 0, minBountyAmount: 0, maxBountyAmount: 0,
      withdrawParamsBurnAmount: Number(sharesRaw), withdrawParamsTokenMintsHash: Array.from(createHash("sha256").update(Buffer.alloc(32)).update(new PublicKey(stockMint).toBuffer()).digest()), withdrawParamsKeepTokensBitmask: keep.mask, withdrawParamsKeepAllTokens: keep.keepAll,
      vaultRebalanceIntent: undefined,
    }),
  ];
  const transaction = new VersionedTransaction(new TransactionMessage({ payerKey: seller, recentBlockhash: owner, instructions }).compileToV0Message());
  return { batches: [{ transactions: [{ tx_b64: Buffer.from(transaction.serialize()).toString("base64"), recent_blockhash: owner, last_valid_block_height: 99, payer: owner, lookup_tables: [] }] }] };
}
const definition = {
  indexId: "idx-theme-mag7-caucus", network: "mainnet-beta", name: "Mag7 Caucus", symbol: "IIMAG7", status: "CREATABLE",
  depositsEnabled: true, depositReason: null, bookSource: null, provenance: {}, vaultAddress: vault, shareMint, vaultLegs: [],
  keeper: { pubkey: "keeper", automationEnabled: true }, hostEntryFeeBps: 25, hostExitFeeBps: 0,
};
function dependencies(payload = auctionPayload(), simulationError: unknown = null, calls: { keep?: string[] } = {}) {
  return {
    loadDefinition: async () => definition,
    nativeBuilder: () => ({
      network: "mainnet-beta", assertNetwork: async () => {},
      connection: {
        getAccountInfo: async () => null,
        getAddressLookupTable: async () => ({ value: null }),
        getBlockHeight: async () => 1,
        simulateTransaction: async () => ({ context: { slot: 42 }, value: { err: simulationError, logs: ["auction simulation"] } }),
      },
      sdk: {
        fetchVault: async () => ({ ownAddress: new PublicKey(vault), mint: new PublicKey(shareMint), numTokens: 1, composition: [{ mint: new PublicKey(stockMint) }], settings: { bountyMint: NATIVE_MINT } }),
        sellVaultTx: async (args: { keep_tokens: string[] }) => { calls.keep = args.keep_tokens; return payload; },
      },
    }),
    release: { publicFundsEnabled: true },
  };
}
function request(body: unknown) {
  return new Request(`http://localhost/api/indexes/${definition.indexId}/withdraw/prepare`, { method: "POST", body: JSON.stringify(body) });
}

test("withdraw prepare returns one simulated owner-claim burn and never an empty keep mask", async () => {
  const calls: { keep?: string[] } = {};
  const response = await handleIndexWithdrawalPrepare(request({ owner, shareAmountRaw: "3", requestedExitMode: "verified-native-usdc", idempotencyKey: "exit-3" }), definition.indexId, dependencies(auctionPayload(), null, calls) as never);
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.network, "mainnet-beta");
  assert.equal(body.phase, "ZAP_OUT_BURN");
  assert.equal(body.requires, "user-signature");
  assert.equal(body.transactions.length, 1);
  assert.equal(body.transactions[0].stepId, "zap-out-burn");
  assert.deepEqual(body.transactions[0].maxDebits, [{ owner, mint: shareMint, amountRaw: "3" }]);
  assert.deepEqual(body.transactions[0].expectedRecipients, [{ owner, mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" }]);
  assert.equal(body.transactions[0].simulation.ok, true);
  assert.deepEqual(calls.keep, [stockMint]);
  assert.equal(body.zapOut.kind, "zap-out");
  assert.equal(body.zapOut.packaging, "staged");
  assert.equal(body.zapOut.atomic, false);
  assert.equal(body.zapOut.keeperSubsidyRaw, "0");
  assert.equal(body.zapOut.userFundsOnly, true);
  assert.equal(body.zapOut.keepTokensEmptyForbidden, true);
  assert.match(body.constraints.map((row: { value: string }) => row.value).join(" "), /You approve each step/);
  assert.match(body.zapOut.warning, /leftover stocks and USDC/);
  assert.match(JSON.stringify(body.constraints), /Not an empty-keep auction/);
  assert.doesNotMatch(JSON.stringify(body.constraints), /then USDC lands/);
  const prepared = VersionedTransaction.deserialize(Buffer.from(body.transactions[0].messageBase64, "base64"));
  const instructions = TransactionMessage.decompile(prepared.message).instructions;
  const init = instructions[4]!;
  assert.equal(init.data[40], 1, "withdraw intent");
  assert.equal(init.data.readBigUInt64LE(69), 3n, "exact share burn");
  assert.notEqual(init.data.readBigUInt64LE(109), 0n, "empty keep mask is not a USDC exit");
  assert.equal(init.data[125], 1, "keep-all claims the bag to the owner");
  assert.deepEqual(instructions.filter(instruction => instruction.programId.equals(TOKEN_PROGRAM_ID)).map(instruction => Array.from(instruction.data)), [[17]], "the burn approval only syncs the bounty wrap; it never delegates wallet tokens to the keeper");
});

test("withdraw prepare refuses an empty keep mask when the goal is USDC", async () => {
  const response = await handleIndexWithdrawalPrepare(
    request({ owner, shareAmountRaw: "3", requestedExitMode: "verified-native-usdc" }),
    definition.indexId,
    dependencies(auctionPayload("3", { mask: new BN(0), keepAll: 0 })) as never,
  );
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "Cash out cannot use an empty keep list when the goal is USDC." });
});

test("withdraw prepare refuses in plain language when the USDC auction cannot simulate", async () => {
  const response = await handleIndexWithdrawalPrepare(
    request({ owner, shareAmountRaw: "3", requestedExitMode: "verified-native-usdc" }),
    definition.indexId,
    dependencies(auctionPayload(), { InstructionError: [0, "AuctionUnavailable"] }) as never,
  );
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "This cash out cannot be settled to USDC right now. Please try again later." });
});

test("withdraw request refuses in-kind mode, malformed shares, and other vaults", async () => {
  assert.throws(() => parseIndexWithdrawalRequest({ owner, shareAmountRaw: "3", requestedExitMode: "in-kind" }), /USDC cash out/);
  assert.throws(() => parseIndexWithdrawalRequest({ owner, shareAmountRaw: "0", requestedExitMode: "verified-native-usdc" }), /u64 range/);
  const absent = await handleIndexWithdrawalPrepare(request({ owner, shareAmountRaw: "3", requestedExitMode: "verified-native-usdc" }), "idx-theme-other", dependencies() as never);
  assert.equal(absent.status, 503);
  assert.deepEqual(await absent.json(), { error: "Cash out is not available for this vault." });
});

test("withdraw prepare is definition-driven for a non-Mag7 index", async () => {
  const otherVault = "H6pLh8nFv1teY9G6JAVQuZQxeUvGfwYf1aPXHkDPDRph";
  const otherMint = "9ihGfswnUZ6MysSR3KgmrZ57FXDVAiAQ6sEHwLuWwzJ4";
  const legMint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const other = {
    ...definition,
    indexId: "idx-theme-silicon-hill",
    name: "Silicon Hill",
    vaultAddress: otherVault,
    shareMint: otherMint,
    vaultLegs: [
      { ticker: "AAA", mint: stockMint, decimals: 8, pool: otherVault, kind: "raydium_clmm", targetWeightBps: 5000 },
      { ticker: "BBB", mint: legMint, decimals: 6, pool: otherVault, kind: "raydium_clmm", targetWeightBps: 3000 },
      { ticker: "CCC", mint: owner, decimals: 6, pool: otherVault, kind: "raydium_clmm", targetWeightBps: 2000 },
    ],
  };
  const calls: { keep?: string[] } = {};
  const response = await handleIndexWithdrawalPrepare(request({ owner, shareAmountRaw: "3", requestedExitMode: "verified-native-usdc" }), other.indexId, {
    loadDefinition: async (id: string) => id === other.indexId ? other : null,
    nativeBuilder: () => ({
      network: "mainnet-beta", assertNetwork: async () => {},
      connection: { getAccountInfo: async () => null, getAddressLookupTable: async () => ({ value: null }), getBlockHeight: async () => 1, simulateTransaction: async () => ({ context: { slot: 7 }, value: { err: null, logs: ["ok"] } }) },
      sdk: {
        fetchVault: async () => ({ ownAddress: new PublicKey(otherVault), mint: new PublicKey(otherMint), numTokens: 1, composition: [{ mint: new PublicKey(stockMint) }], settings: { bountyMint: NATIVE_MINT } }),
        sellVaultTx: async (args: { keep_tokens: string[] }) => { calls.keep = args.keep_tokens; return auctionPayload("3", { mask: new BN(1), keepAll: 1 }, otherVault, otherMint); },
      },
    }),
    release: { publicFundsEnabled: true },
  } as never);
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.zapOut.indexId, "idx-theme-silicon-hill");
  assert.equal(body.zapOut.legCount, 3);
  assert.deepEqual(body.zapOut.legs.map((leg: { ticker: string }) => leg.ticker), ["AAA", "BBB", "CCC"]);
  assert.notEqual(calls.keep?.length, 0);
  assert.equal(body.zapOut.keeperSubsidyRaw, "0");
});

test("claim stage is an owner-signed redeem, not a keeper-paid sale", async () => {
  const legMint = "H6pLh8nFv1teY9G6JAVQuZQxeUvGfwYf1aPXHkDPDRph";
  const withLegs = { ...definition, vaultLegs: [{ ticker: "AAPL", mint: legMint, decimals: 8, pool: vault, kind: "raydium_clmm", targetWeightBps: 10_000 }] };
  const response = await handleIndexWithdrawalPrepare(request({ owner, shareAmountRaw: "3", requestedExitMode: "verified-native-usdc", resume: "claim" }), definition.indexId, {
    ...dependencies(),
    loadDefinition: async () => withLegs,
    nativeBuilder: () => ({
      network: "mainnet-beta", assertNetwork: async () => {},
      connection: {
        getAccountInfo: async () => ({ owner: SystemProgram.programId }),
        getAddressLookupTable: async () => ({ value: null }),
        getBlockHeight: async () => 1,
        getLatestBlockhash: async () => ({ blockhash: owner, lastValidBlockHeight: 99 }),
        simulateTransaction: async () => ({ context: { slot: 9 }, value: { err: null, logs: ["claim"] } }),
      },
      sdk: { fetchVault: async () => ({ ownAddress: new PublicKey(vault), mint: new PublicKey(shareMint), numTokens: 1, composition: [{ mint: new PublicKey(stockMint) }] }) },
    }),
    loadClaim: async () => [{ mint: legMint, amountRaw: "8", tokenProgram: TOKEN_PROGRAM_ID.toBase58() }],
  } as never);
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.phase, "ZAP_OUT_CLAIM");
  assert.equal(body.requires, "user-signature");
  assert.equal(body.transactions.length, 1);
  assert.equal(body.transactions[0].stepId, "zap-out-claim");
  assert.deepEqual(body.transactions[0].expectedRecipients, [{ owner, mint: legMint }]);
  assert.equal(body.zapOut.keeperSubsidyRaw, "0");
  const prepared = VersionedTransaction.deserialize(Buffer.from(body.transactions[0].messageBase64, "base64"));
  assert.equal(prepared.message.staticAccountKeys[0]?.toBase58(), owner);
  assert.equal(prepared.message.header.numRequiredSignatures, 1);
});

test("sell stage quotes only the claimed DB-leg delta and leaves an unquoted name as stock", async () => {
  const legMint = "H6pLh8nFv1teY9G6JAVQuZQxeUvGfwYf1aPXHkDPDRph";
  const missed = "9ihGfswnUZ6MysSR3KgmrZ57FXDVAiAQ6sEHwLuWwzJ4";
  const withLegs = { ...definition, vaultLegs: [
    { ticker: "AAPL", mint: legMint, decimals: 8, pool: vault, kind: "raydium_clmm", targetWeightBps: 6000 },
    { ticker: "MSFT", mint: missed, decimals: 8, pool: vault, kind: "raydium_clmm", targetWeightBps: 4000 },
  ] };
  const swap = SystemProgram.transfer({ fromPubkey: new PublicKey(owner), toPubkey: new PublicKey(owner), lamports: 1 });
  const quoted: string[] = [];
  const response = await handleIndexWithdrawalPrepare(request({ owner, shareAmountRaw: "3", requestedExitMode: "verified-native-usdc", resume: "sell", claimSignature: "3" + "1".repeat(86) }), definition.indexId, {
    ...dependencies(),
    loadDefinition: async () => withLegs,
    loadClaimDeltas: async () => [{ mint: legMint, amountRaw: "5" }, { mint: missed, amountRaw: "9" }, { mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", amountRaw: "40" }],
    quoteSell: async (input: { inputMint: string; amountRaw: string }) => {
      quoted.push(`${input.inputMint}:${input.amountRaw}`);
      if (input.inputMint === missed) return null;
      return {
        inputMint: input.inputMint, outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", inAmount: input.amountRaw, outAmount: "1000", minOutRaw: "900",
        slippageBps: 50, taker: owner, destinationTokenAccount: null, swapProgramId: SystemProgram.programId.toBase58(),
        instructions: [swap], lookupTables: [], recentBlockhash: owner, lastValidBlockHeight: 99,
      };
    },
  } as never);
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.phase, "ZAP_OUT_SELL");
  assert.equal(body.transactions.length, 1);
  assert.equal(body.transactions[0].stepId, `zap-out-sell-${legMint}`);
  assert.deepEqual(body.transactions[0].maxDebits, [{ owner, mint: legMint, amountRaw: "5" }]);
  assert.deepEqual(quoted, [`${legMint}:5`, `${missed}:9`]);
  assert.equal(body.zapOut.sells.length, 1);
  assert.equal(body.zapOut.residuals.find((row: { mint: string }) => row.mint === missed)?.reason, "jupiter-unavailable");
  assert.equal(body.zapOut.keeperSubsidyRaw, "0");
  assert.match(body.zapOut.warning, /leftover stocks and USDC/);
});
