import test from "node:test";
import assert from "node:assert/strict";
import { AddressLookupTableAccount, Connection, PublicKey, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { MintLayout, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import type { AddOrEditTokenInput, Vault } from "@symmetry-hq/sdk";
import { PYTHNET_CUSTODY_PRICE_USDC_ACCOUNT, PYTHNET_CUSTODY_PRICE_WSOL_ACCOUNT, VAULTS_V3_PROGRAM_ID } from "@symmetry-hq/sdk/dist/constants.js";
import { RaydiumCpmmPoolState } from "@symmetry-hq/sdk/dist/states/oracles/raydiumCpmmOracle.js";
import {
  assertNoPythEnvironment, assertRaydiumOnlyToken, assertRaydiumOnlyVault, DEVNET_RAYDIUM_POOLS, planRaydiumPriceUpdate,
  raydiumCpmmObservationTimestamp, raydiumPoolFor, WSOL_MINT,
} from "../src/lib/index-vaults/raydium-oracles.ts";
import {
  assertRaydiumLogs, assertSolDebitBudget, DevnetSettler, fromPayload, intentNextAction, oracleTypesFromLogs, parseSettleArgs, SETTLE_TEST_VAULT,
  settleConnection, simulatedWalletDebit, solToLamports, summarizeInstructions,
} from "../src/lib/index-vaults/devnet-settle.ts";
import { NativeVaultBuilders } from "../src/lib/index-vaults/symmetry-adapter.ts";
import { devnetTestIdentity } from "../src/lib/index-vaults/devnet-deposit.ts";
import type { UIRebalanceIntent } from "@symmetry-hq/sdk";

/** Minimal BN stand-in for the SDK fields the planner reads. */
const BN = (value: number) => ({ isZero: () => value === 0, toString: () => String(value) });
const POOL = "5Eu2G2USTy1pqphmQzQ2SBXWrBq5sdhgEh7hso9R2xix";
const VAULT = "Jh7cFNUT5FrtBwKakApsc3Gg5aTQjsZtYxa4dbrCoB8";
const KEEPER = "C7ye6UvJ7jirwCmt3fKmt55MvcW9yBVpgqzZzgCWYQyB";
const INTENT = "8YE4XGm767rVxFhEYr8snLDxgRf1G9YLCPwPBKD3QBCL";
const USDC = "USDCoctVLVnvTXBEuP9s8hntucdJokbo17RwHuNXemT";
const poolAccounts = [POOL, "Aw93pmXP52u6WSW2HcafRxua1LDht5MZhhXaaR7qCjsN", "CPLUA2NTYSGjsB1E9iXT3MrPn69WRFJvKTdJZw5NdEjh", "7LnqjXdqJEdccWZQs5YJobQ8MDmcK4sG2oo4Ty4LBC8c"];

const oracleInput = (oracle_type: string) => ({
  oracle_type, account_lut_id: 0, account_lut_index: 10, account: POOL, weight_bps: 10000, is_required: true, conf_thresh_bps: 9999,
  volatility_thresh_bps: 9999, max_slippage_bps: 9999, min_liquidity: 0, staleness_thresh: 3600, staleness_conf_rate_bps: 0, token_decimals: 9,
  twap_seconds_ago: 30, twap_secondary_seconds_ago: 120, quote_token: "usdc",
}) as AddOrEditTokenInput["oracles"][number];
const tokenInput = (...types: string[]): AddOrEditTokenInput => ({ token_mint: WSOL_MINT, active: true, min_oracles_thresh: 1, min_conf_bps: 50, conf_thresh_bps: 200, conf_multiplier: 1, oracles: types.map(oracleInput) });

/** Mirrors the live devnet vault: two tokens, one Raydium CPMM oracle each, four loaded accounts per oracle from LUT 0. */
function fixtureVault(types: [number, number] = [2, 2]): Vault {
  const lut = ["11111111111111111111111111111111", "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL", "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", VAULTS_V3_PROGRAM_ID.toBase58(),
    "BV49JWNeVnRjvMg4BHVoRFXNXHMFqgZFsfHg2QUekynd", VAULT, "Cdxoni8uv7FrqVfeHJ6YC4DeXs3QQ2uG4nT3BDd9Ny2A", "BSBqMSbSVFcT7FPQ1rR5KYLdqqvA5T6xjgcv9E3PiVXV",
    PYTHNET_CUSTODY_PRICE_WSOL_ACCOUNT.toBase58(), PYTHNET_CUSTODY_PRICE_USDC_ACCOUNT.toBase58(), ...poolAccounts].map(k => new PublicKey(k));
  const oracle = (type: number, indices: number[]) => ({ oracleSettings: { oracleType: type, numRequiredAccounts: 4, stalenessThresh: BN(3600), side: indices[1] === 12 ? 1 : 0 },
    accountsToLoadLutIds: [0, 0, 0, 0], accountsToLoadLutIndices: indices });
  return {
    ownAddress: new PublicKey(VAULT), mint: new PublicKey("Cdxoni8uv7FrqVfeHJ6YC4DeXs3QQ2uG4nT3BDd9Ny2A"), numTokens: 2,
    composition: [
      { mint: new PublicKey(WSOL_MINT), amount: BN(0), weight: 5000, active: 1, oracleAggregator: { numOracles: 1, oracles: [oracle(types[0], [10, 11, 12, 13])] } },
      { mint: new PublicKey(USDC), amount: BN(100000), weight: 5000, active: 1, oracleAggregator: { numOracles: 1, oracles: [oracle(types[1], [10, 12, 11, 13])] } },
    ],
    lookupTables: { active: [new PublicKey("64g9E6EcsuvbJD5Rk1z3cc8AUWcPDi2LDCSMB2mMWNQQ"), new PublicKey("CDYTLBNR874M9yN6mAbFefrho3byDajMpKpNat7TbaRg")] },
    lutPubkeys: [{ state: { addresses: lut } }, { state: { addresses: [] } }],
    settings: { creator: new PublicKey(KEEPER), host: new PublicKey(KEEPER), activeRebalance: BN(0), fees: { hostPerformanceFeeBps: 0, creatorPerformanceFeeBps: 0, managersPerformanceFeeBps: 0 } },
  } as unknown as Vault;
}

test("oracle inputs: pyth and every non-Raydium type are rejected before reaching the native builder", () => {
  assert.doesNotThrow(() => assertRaydiumOnlyToken(tokenInput("raydium_cpmm")));
  for (const type of ["pyth", "lst", "overpass", "byreal_clmm", "meteora_dlmm", "example", "PYTH", "", "constructor", "__proto__", "toString", "hasOwnProperty"]) assert.throws(() => assertRaydiumOnlyToken(tokenInput(type)), /ORACLE_TYPE_FORBIDDEN/);
  assert.throws(() => assertRaydiumOnlyToken(tokenInput(2 as unknown as string)), /ORACLE_TYPE_FORBIDDEN/);
  assert.throws(() => assertRaydiumOnlyToken(tokenInput("raydium_cpmm", "pyth")), /ORACLE_TYPE_FORBIDDEN/);
  assert.throws(() => assertRaydiumOnlyToken(tokenInput()), /ORACLE_REQUIRED/);
});

test("token configuration must match the documented Raydium pool and kind", () => {
  assert.throws(() => assertRaydiumOnlyToken(tokenInput("raydium_clmm")), /ORACLE_KIND_MISMATCH/);
  const wrongPool = tokenInput("raydium_cpmm");
  wrongPool.oracles[0].account = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
  assert.throws(() => assertRaydiumOnlyToken(wrongPool), /RAYDIUM_POOL_MISMATCH/);
});

test("pool bindings name only mint → Raydium pool + kind; unknown mints block listing instead of inventing a pool", () => {
  assert.deepEqual(raydiumPoolFor(WSOL_MINT), { mint: WSOL_MINT, pool: POOL, kind: "raydium_cpmm" });
  assert.equal(raydiumPoolFor(USDC).pool, POOL);
  assert.throws(() => raydiumPoolFor("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"), /RAYDIUM_POOL_REQUIRED/);
  for (const binding of DEVNET_RAYDIUM_POOLS) assert.ok(!("pyth" in binding) && ["raydium_clmm", "raydium_cpmm"].includes(binding.kind));
});

test("installed native oracles must all be Raydium; a Pyth slot fails the vault closed", () => {
  assert.deepEqual(assertRaydiumOnlyVault(fixtureVault()), [{ mint: WSOL_MINT, oracleTypes: [2] }, { mint: USDC, oracleTypes: [2] }]);
  assert.throws(() => assertRaydiumOnlyVault(fixtureVault([2, 0])), /ORACLE_TYPE_FORBIDDEN.*type 0/);
  assert.throws(() => assertRaydiumOnlyVault(fixtureVault([3, 2])), /ORACLE_TYPE_FORBIDDEN/);
  assert.throws(() => assertRaydiumOnlyVault(fixtureVault([1, 2])), /ORACLE_KIND_MISMATCH/);
  const wrongPool = fixtureVault();
  wrongPool.lutPubkeys![0].state.addresses[10] = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
  assert.throws(() => assertRaydiumOnlyVault(wrongPool), /RAYDIUM_POOL_MISMATCH/);
});

test("HERMES_*/PYTH_* environment fails the settlement path closed", () => {
  assert.doesNotThrow(() => assertNoPythEnvironment({ PATH: "/bin", JUPITER_MODE: "live" } as unknown as NodeJS.ProcessEnv));
  assert.throws(() => assertNoPythEnvironment({ HERMES_URL: "https://hermes.example" } as unknown as NodeJS.ProcessEnv), /PYTH_ENV_FORBIDDEN: unset HERMES_URL/);
  assert.throws(() => assertNoPythEnvironment({ pyth_api_key: "x" } as unknown as NodeJS.ProcessEnv), /PYTH_ENV_FORBIDDEN/);
});

test("Raydium price update loads exactly the vault's pool accounts, no Pyth feed accounts and no Hermes batches", () => {
  const plan = planRaydiumPriceUpdate({ vault: fixtureVault(), keeper: KEEPER, rebalanceIntent: INTENT });
  assert.equal(plan.instructions.length, 1);
  assert.deepEqual(plan.tokenIndices, [[0, 1]]);
  assert.deepEqual(plan.oracleAccounts, [[...poolAccounts, POOL, poolAccounts[2], poolAccounts[1], poolAccounts[3]]]);
  const ix = plan.instructions[0];
  assert.ok(ix.programId.equals(VAULTS_V3_PROGRAM_ID));
  assert.equal(Buffer.from(ix.data.subarray(0, 8)).toString("hex"), "93578c21d6bdb5f2"); // update_token_prices
  assert.deepEqual([...ix.data.subarray(8)], [0, 1, ...new Array(18).fill(0)]);
  const keys = ix.keys.map(k => k.pubkey.toBase58());
  assert.equal(keys[0], KEEPER); assert.equal(keys[1], VAULT); assert.equal(keys[2], INTENT);
  assert.ok(ix.keys[0].isSigner && !ix.keys.slice(1).some(k => k.isSigner));
  // Remaining accounts are only Raydium pool state/vaults/observation; the custody slots are fixed program accounts, not our oracles.
  assert.deepEqual(keys.slice(9), plan.oracleAccounts[0]);
  assert.equal(keys[8], VAULTS_V3_PROGRAM_ID.toBase58(), "no vault rebalance intent when none is active");
  assert.throws(() => planRaydiumPriceUpdate({ vault: fixtureVault([0, 2]), keeper: KEEPER, rebalanceIntent: INTENT }), /ORACLE_TYPE_FORBIDDEN/);
  const active = fixtureVault(); (active.settings as { activeRebalance: unknown }).activeRebalance = BN(1);
  assert.equal(planRaydiumPriceUpdate({ vault: active, keeper: KEEPER, rebalanceIntent: INTENT }).instructions[0].keys[8].pubkey.toBase58(), "BSBqMSbSVFcT7FPQ1rR5KYLdqqvA5T6xjgcv9E3PiVXV");
  const missing = fixtureVault(); (missing.lutPubkeys as unknown[])[0] = { state: { addresses: [] } };
  assert.throws(() => planRaydiumPriceUpdate({ vault: missing, keeper: KEEPER, rebalanceIntent: INTENT }), /ORACLE_ACCOUNT_MISSING/);
});

test("Raydium CPMM observation ring decodes the current observation timestamp", () => {
  const data = Buffer.alloc(8 + 1 + 2 + 32 + 100 * 40 + 32);
  data.writeUInt8(1, 8); data.writeUInt16LE(68, 9);
  data.writeBigUInt64LE(1789460582n, 8 + 1 + 2 + 32 + 68 * 40);
  assert.equal(raydiumCpmmObservationTimestamp(data), 1789460582);
  data.writeUInt16LE(100, 9);
  assert.throws(() => raydiumCpmmObservationTimestamp(data), /observation index/);
  assert.throws(() => raydiumCpmmObservationTimestamp(Buffer.alloc(10)), /Malformed/);
});

test("settlement pool observation decodes the installed Raydium CPMM state", async () => {
  const observationKey = new PublicKey("7LnqjXdqJEdccWZQs5YJobQ8MDmcK4sG2oo4Ty4LBC8c");
  const observationData = Buffer.alloc(8 + 1 + 2 + 32 + 100 * 40 + 32);
  observationData.writeUInt8(1, 8);
  observationData.writeUInt16LE(0, 9);
  observationData.writeBigUInt64LE(BigInt(Math.floor(Date.now() / 1000)), 8 + 1 + 2 + 32);
  const originalDecode = RaydiumCpmmPoolState.decode;
  RaydiumCpmmPoolState.decode = (() => ({ observationKey })) as unknown as typeof RaydiumCpmmPoolState.decode;
  const connection = {
    getAccountInfo: async (key: PublicKey) => key.equals(observationKey)
      ? { data: observationData, owner: PublicKey.default }
      : { data: Buffer.alloc(1), owner: new PublicKey(SETTLE_TEST_VAULT.raydiumCpmmProgram) },
  } as unknown as Connection;
  try {
    const result = await new DevnetSettler(connection).pool(fixtureVault());
    assert.equal(result.binding.pool, POOL);
    assert.equal(result.summary.fresh, true);
  } finally {
    RaydiumCpmmPoolState.decode = originalDecode;
  }
});

test("program logs prove the oracle type per token; a Pyth (type 0) read fails settlement closed", () => {
  const logs = [
    "Program log: Instruction: UpdateTokenPricesHandler",
    `Program log: * loading price for: ${WSOL_MINT}`, "Program log: * * oracle: i 0 type: 2 price: 81.789503334", "Program log: * oracle aggregation price: 81.789503334",
    `Program log: * loading price for: ${USDC}`, "Program log: * * oracle: i 0 type: 2 price: 1.229878984",
  ];
  assert.deepEqual(oracleTypesFromLogs(logs), [{ mint: WSOL_MINT, oracleType: 2, price: "81.789503334" }, { mint: USDC, oracleType: 2, price: "1.229878984" }]);
  assert.doesNotThrow(() => assertRaydiumLogs(logs));
  assert.doesNotThrow(() => assertRaydiumLogs(logs, [WSOL_MINT, USDC]));
  assert.throws(() => assertRaydiumLogs([], [WSOL_MINT, USDC]), /RAYDIUM_LOG_MISSING.*So111.*USDCoct/);
  assert.throws(() => assertRaydiumLogs(logs.slice(0, 4), [WSOL_MINT, USDC]), /RAYDIUM_LOG_MISSING.*USDCoct/);
  assert.throws(() => assertRaydiumLogs([`Program log: * loading price for: ${WSOL_MINT}`, "Program log: * * oracle: i 0 type: 0 price: 100.478665150"]), /ORACLE_TYPE_FORBIDDEN in program logs/);
  assert.doesNotThrow(() => assertRaydiumLogs(["Program log: Instruction: MintBasketHandler"]));
});

test("SOL debit authorization uses the simulated payer delta before broadcast", () => {
  assert.equal(simulatedWalletDebit(100_000n, 69_378), 30_622n);
  assert.equal(simulatedWalletDebit(100_000n, null), null);
  assert.doesNotThrow(() => assertSolDebitBudget(0n, 30_622n, 30_000, 30_622n, "deposit"));
  assert.throws(() => assertSolDebitBudget(0n, 30_622n, 30_000, 30_000n, "deposit"), /would be exceeded.*refusing to send/);
  assert.throws(() => assertSolDebitBudget(0n, null, 5_000, 25_000n, "mint"), /wallet debit unavailable.*refusing to send/);
  assert.throws(() => assertSolDebitBudget(0n, 5_000n, null, 25_000n, "mint"), /fee unavailable.*refusing to send/);
});

test("settlement CLI: strict flags, required intent, devnet-only RPC that rejects sends in dry-run", () => {
  assert.deepEqual(parseSettleArgs([]), { step: "observe", execute: false, maxSolDebit: "0.02" });
  assert.equal(parseSettleArgs(["--step", "mint", "--intent", INTENT]).intent, INTENT);
  assert.throws(() => parseSettleArgs(["--step", "mint"]), /--intent is required/);
  assert.throws(() => parseSettleArgs(["--step", "deposit"]), /--usdc-raw is required/);
  assert.throws(() => parseSettleArgs(["--step", "deposit", "--usdc-raw", "0"]));
  assert.throws(() => parseSettleArgs(["--step", "redeem"]), /Unknown step/);
  assert.throws(() => parseSettleArgs(["--step", "refresh-pool"]), /Unknown step/);
  for (const bad of [["--rpc", "x"], ["--vault", VAULT], ["--network", "mainnet"], ["--yes"]]) assert.throws(() => parseSettleArgs(bad), /Unsupported argument/);
  assert.throws(() => parseSettleArgs(["--intent", "not-a-key"]));
  assert.equal(solToLamports("0.02"), 20_000_000n);
  assert.throws(() => solToLamports("0"), /positive/);
  assert.throws(() => solToLamports("1.0000000001"));
  const dry = settleConnection(false);
  assert.rejects(() => dry.sendRawTransaction(Buffer.alloc(8)), /not permitted in dry-run/);
  assert.rejects(() => dry.requestAirdrop(new PublicKey(KEEPER), 1), /not permitted/);
  assert.rejects(() => settleConnection(true).requestAirdrop(new PublicKey(KEEPER), 1), /not permitted/);
});

test("intent stage follows the SDK's single filled data slot", () => {
  const ui = (slot: string | null) => ({ deposit_data: null, price_updates_data: null, auction_data: null, mint_data: null, redeem_data: null, claim_bounty_data: null, ...(slot ? { [slot]: {} } : {}) }) as unknown as UIRebalanceIntent;
  assert.equal(intentNextAction(ui("deposit_data")), "deposit-tokens");
  assert.equal(intentNextAction(ui("price_updates_data")), "update-prices");
  assert.equal(intentNextAction(ui("auction_data")), "auction-wait");
  assert.equal(intentNextAction(ui("mint_data")), "mint");
  assert.equal(intentNextAction(ui("claim_bounty_data")), "claim-bounty");
  assert.equal(intentNextAction(ui(null)), "unknown");
});

test("payload batches deserialize to reviewable versioned transactions", () => {
  const plan = planRaydiumPriceUpdate({ vault: fixtureVault(), keeper: KEEPER, rebalanceIntent: INTENT });
  const message = new TransactionMessage({ payerKey: new PublicKey(KEEPER), recentBlockhash: PublicKey.default.toBase58(), instructions: plan.instructions }).compileToV0Message();
  const tx = new VersionedTransaction(message);
  const payload = { batches: [{ transactions: [{ tx_b64: Buffer.from(tx.serialize()).toString("base64"), message_version: "0" as const, recent_blockhash: "", payer: KEEPER, lookup_tables: [], instructions: [] }] }] };
  const [[decoded]] = fromPayload(payload);
  const [summary] = summarizeInstructions(decoded);
  assert.equal(summary.program, VAULTS_V3_PROGRAM_ID.toBase58());
  assert.equal(summary.discriminator, "93578c21d6bdb5f2");
  assert.equal(summary.staticAccounts[0], KEEPER);
});

test("settle prices builds the real native Raydium transaction without non-devnet network access", async () => {
  const vault = fixtureVault();
  const lookupTableData = (addresses: PublicKey[]) => {
    const data = Buffer.alloc(56 + addresses.length * 32);
    data.writeUInt32LE(1, 0);
    data.writeBigUInt64LE(0xffffffffffffffffn, 4);
    addresses.forEach((key, index) => key.toBuffer().copy(data, 56 + index * 32));
    return data;
  };
  const mintData = Buffer.alloc(MintLayout.span);
  MintLayout.encode({ mintAuthorityOption: 0, mintAuthority: PublicKey.default, supply: 0n, decimals: 6, isInitialized: true,
    freezeAuthorityOption: 0, freezeAuthority: PublicKey.default }, mintData);
  const rpcAccount = (data: Buffer, owner: PublicKey) => ({ data: [data.toString("base64"), "base64"], executable: false, lamports: 1, owner: owner.toBase58(), rentEpoch: 0, space: data.length });
  const rpcFetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url !== "https://api.devnet.solana.com") throw new Error(`NON_DEVNET_NETWORK_FORBIDDEN: ${url}`);
    const body = JSON.parse(String(init?.body));
    const response = (call: { id: number; method: string; params: unknown[] }) => {
      let result: unknown;
      if (call.method === "getGenesisHash") result = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
      else if (call.method === "getAccountInfo") {
        const key = String(call.params[0]);
        const account = key === VAULT ? rpcAccount(Buffer.alloc(8), VAULTS_V3_PROGRAM_ID) : key === devnetTestIdentity.shareMint ? rpcAccount(mintData, TOKEN_PROGRAM_ID) : null;
        result = { context: { slot: 1 }, value: account };
      } else if (call.method === "getLatestBlockhash") result = { context: { slot: 1 }, value: { blockhash: PublicKey.default.toBase58(), lastValidBlockHeight: 10 } };
      else if (call.method === "getMultipleAccounts") {
        const keys = call.params[0] as string[];
        result = { context: { slot: 1 }, value: keys.map(key => {
          const index = vault.lookupTables.active.findIndex(table => table.toBase58() === key);
          return index < 0 ? null : rpcAccount(lookupTableData(vault.lutPubkeys?.[index].state.addresses ?? []), PublicKey.default);
        }) };
      } else throw new Error(`Unexpected RPC method ${call.method}`);
      return { jsonrpc: "2.0", id: call.id, result };
    };
    const payload = Array.isArray(body) ? body.map(response) : response(body);
    return new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = rpcFetch as typeof fetch;
  try {
    const builder = new NativeVaultBuilders(new Connection("https://api.devnet.solana.com", { fetch: rpcFetch as typeof fetch }), "devnet");
    Object.defineProperty(builder.sdk, "fetchVault", { value: async () => vault });
    const payload = await builder.settle("prices", KEEPER, devnetTestIdentity, INTENT);
    assert.equal(payload.batches.length, 1);
    assert.equal(payload.batches[0].transactions.length, 1);
    const transaction = VersionedTransaction.deserialize(Buffer.from(payload.batches[0].transactions[0].tx_b64, "base64"));
    const lookupTables = vault.lookupTables.active.map((key, index) => new AddressLookupTableAccount({ key, state: {
      deactivationSlot: 0xffffffffffffffffn, lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, authority: undefined,
      addresses: vault.lutPubkeys?.[index].state.addresses ?? [],
    } }));
    const accountKeys = transaction.message.getAccountKeys({ addressLookupTableAccounts: lookupTables });
    const native = transaction.message.compiledInstructions.filter(ix => accountKeys.get(ix.programIdIndex)?.equals(VAULTS_V3_PROGRAM_ID));
    assert.equal(native.length, 1);
    assert.equal(Buffer.from(native[0].data.subarray(0, 8)).toString("hex"), "93578c21d6bdb5f2");
    assert.deepEqual(native[0].accountKeyIndexes.slice(9).map(index => accountKeys.get(index)?.toBase58()), [...poolAccounts, POOL, poolAccounts[2], poolAccounts[1], poolAccounts[3]]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
