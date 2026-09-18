import BN from "bn.js";
import { ClmmInstrument, PoolInfoLayout, ClmmConfigLayout, PoolUtils, TickArrayUtil, swapInternal, type ApiV3PoolInfoConcentratedItem } from "@raydium-io/raydium-sdk-v2";
import { AddressLookupTableAccount, AddressLookupTableProgram, PublicKey, type Connection, type TransactionInstruction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, unpackMint, getExtensionTypes, ExtensionType, getTransferHook, getPausableConfig, getDefaultAccountState, AccountState, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { rawAmount, sha256 } from "./amounts.ts";
import type { PersistedVaultLeg } from "./vault-definition-store.ts";
import { MAINNET_USDC } from "./native-defaults.ts";

export const CYCLE_CLMM_PROGRAM = "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK";
export interface CycleRoute {
  pool: string; inputMint: string; outputMint: string; amountInRaw: string; expectedOutRaw: string; minOutRaw: string;
  inputProgram: string; outputProgram: string; quotedAt: number; expiresAt: number; tvlUsd: number;
  instruction: TransactionInstruction; lookupTables: AddressLookupTableAccount[];
}
export function assertCycleRouteInstruction(route: CycleRoute, owner: string): void {
  const ix = route.instruction, inputProgram = new PublicKey(route.inputProgram), outputProgram = new PublicKey(route.outputProgram);
  if (![inputProgram, outputProgram].every(p => p.equals(TOKEN_PROGRAM_ID) || p.equals(TOKEN_2022_PROGRAM_ID)) || ix.programId.toBase58() !== CYCLE_CLMM_PROGRAM || ix.keys.length < 14 || ix.data.length !== 41 || !ix.data.subarray(0, 8).equals(Buffer.from(sha256("global:swap_v2").slice(0, 16), "hex")) || ix.data[40] !== 1 || ix.data.subarray(24, 40).some(b => b !== 0)) throw new Error("CYCLE_ROUTE_INSTRUCTION_SHAPE");
  if (ix.data.readBigUInt64LE(8) !== rawAmount(route.amountInRaw, true) || ix.data.readBigUInt64LE(16) !== rawAmount(route.minOutRaw, true)) throw new Error("CYCLE_ROUTE_INSTRUCTION_AMOUNTS");
  if (ix.keys[0].pubkey.toBase58() !== owner || !ix.keys[0].isSigner || ix.keys.some((k, n) => n !== 0 && k.isSigner) || ix.keys[2].pubkey.toBase58() !== route.pool || ix.keys[11].pubkey.toBase58() !== route.inputMint || ix.keys[12].pubkey.toBase58() !== route.outputMint ||
    !getAssociatedTokenAddressSync(new PublicKey(route.inputMint), new PublicKey(owner), false, inputProgram).equals(ix.keys[3].pubkey) || !getAssociatedTokenAddressSync(new PublicKey(route.outputMint), new PublicKey(owner), false, outputProgram).equals(ix.keys[4].pubkey)) throw new Error("CYCLE_ROUTE_INSTRUCTION_RECIPIENT");
}
export type PoolMetadata = (pool: string) => Promise<{ pool: ApiV3PoolInfoConcentratedItem; observedAt: number; lookupTable?: string }>;
export async function readCyclePoolMetadata(pool: string): ReturnType<PoolMetadata> {
  const response = await fetch(`https://api-v3.raydium.io/pools/info/ids?ids=${encodeURIComponent(pool)}`, { cache: "no-store", redirect: "error", signal: AbortSignal.timeout(15_000) });
  const body = await response.json();
  if (!response.ok || !body.success || !Array.isArray(body.data) || body.data.length !== 1 || body.data[0]?.id !== pool) throw new Error("CYCLE_POOL_METADATA_UNAVAILABLE");
  const observedAt = Date.now();
  const keysResponse = await fetch(`https://api-v3.raydium.io/pools/key/ids?ids=${encodeURIComponent(pool)}`, { cache: "no-store", redirect: "error", signal: AbortSignal.timeout(15_000) });
  const keys = await keysResponse.json();
  if (!keysResponse.ok || !keys.success || keys.data?.length !== 1 || keys.data[0]?.id !== pool) throw new Error("CYCLE_POOL_KEYS_UNAVAILABLE");
  return { pool: body.data[0], observedAt, lookupTable: keys.data[0].lookupTableAccount };
}
export function assertCycleMint(mint: ReturnType<typeof unpackMint>): void {
  if (!mint.isInitialized) throw new Error("CYCLE_MINT_UNINITIALIZED");
  const allowed = new Set<number>([ExtensionType.MetadataPointer, ExtensionType.TokenMetadata, ExtensionType.PermanentDelegate, ExtensionType.DefaultAccountState,
    ExtensionType.ConfidentialTransferMint, ExtensionType.TransferHook, ExtensionType.InterestBearingConfig, ExtensionType.ScaledUiAmountConfig, ExtensionType.PausableConfig]);
  for (const extension of getExtensionTypes(mint.tlvData)) if (!allowed.has(extension)) throw new Error(`CYCLE_UNPROVED_MINT_EXTENSION:${extension}`);
  const hook = getTransferHook(mint);
  if (hook && !hook.programId.equals(PublicKey.default)) throw new Error("CYCLE_ACTIVE_TRANSFER_HOOK_UNSUPPORTED");
  if (getPausableConfig(mint)?.paused) throw new Error("CYCLE_MINT_PAUSED");
  const defaults = getDefaultAccountState(mint);
  if (defaults && defaults.state !== AccountState.Initialized) throw new Error("CYCLE_FROZEN_DEFAULT_ACCOUNT");
  // Raw Token-2022 amounts are authoritative. Never apply scaled-UI multipliers to native raw prices.
}

/** Direct swap on the persisted Raydium pool, not the aggregator's best-price pool (which may
 * be below $10k). Real SDK tick traversal, integer min-out, exact wallet ATA recipients.
 * Unsupported pool/extension shapes refuse the whole index rather than dropping a leg. */
export async function buildCycleRoute(input: {
  connection: Connection; leg: PersistedVaultLeg; owner: string; inputMint: string; outputMint: string;
  amountInRaw: string; slippageBps: number; maxAgeMs: number; minimumOutRaw?: string;
  metadata?: PoolMetadata; now?: () => number;
}): Promise<CycleRoute> {
  const { connection, leg } = input, now = input.now ?? Date.now;
  const amount = rawAmount(input.amountInRaw, true);
  if (leg.kind !== "raydium_clmm") throw new Error("CYCLE_POOL_EXECUTION_NOT_PROVED:only direct CLMM SwapV2 is admitted");
  if (!Number.isInteger(input.slippageBps) || input.slippageBps < 0 || input.slippageBps >= 10000 || input.maxAgeMs < 1 || input.maxAgeMs > 60000) throw new Error("CYCLE_ROUTE_LIMITS");
  if (new Set([input.inputMint, input.outputMint]).size !== 2 || ![input.inputMint, input.outputMint].includes(leg.mint) || ![input.inputMint, input.outputMint].includes(MAINNET_USDC)) throw new Error("CYCLE_ROUTE_PAIR");
  const start = now(), program = new PublicKey(CYCLE_CLMM_PROGRAM), poolId = new PublicKey(leg.pool);
  const [poolAccount, inAccount, outAccount] = await connection.getMultipleAccountsInfo([poolId, new PublicKey(input.inputMint), new PublicKey(input.outputMint)], "confirmed");
  if (!poolAccount?.owner.equals(program)) throw new Error("CYCLE_POOL_OWNER");
  const state = PoolInfoLayout.decode(poolAccount.data);
  if (state.status !== 0 || state.liquidity.isZero() || ![state.mintA.toBase58(), state.mintB.toBase58()].includes(input.inputMint) || ![state.mintA.toBase58(), state.mintB.toBase58()].includes(input.outputMint)) throw new Error("CYCLE_POOL_STATE");
  for (const [key, account] of [[input.inputMint, inAccount], [input.outputMint, outAccount]] as const) {
    if (!account || ![TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].some(p => p.equals(account.owner))) throw new Error("CYCLE_TOKEN_PROGRAM");
    const mint = unpackMint(new PublicKey(key), account, account.owner); assertCycleMint(mint);
    if (mint.decimals !== (key === MAINNET_USDC ? 6 : leg.decimals)) throw new Error("CYCLE_MINT_DECIMALS");
  }
  const metadata = await (input.metadata ?? readCyclePoolMetadata)(leg.pool);
  if (metadata.observedAt > now() || now() - metadata.observedAt > input.maxAgeMs || !Number.isFinite(metadata.pool.tvl) || metadata.pool.tvl < 10_000) throw new Error("CYCLE_POOL_FLOOR_OR_STALE");
  if (metadata.pool.id !== leg.pool || metadata.pool.programId !== CYCLE_CLMM_PROGRAM || metadata.pool.mintA.address !== state.mintA.toBase58() || metadata.pool.mintB.address !== state.mintB.toBase58()) throw new Error("CYCLE_POOL_METADATA_IDENTITY");
  const configAccount = await connection.getAccountInfo(state.configId, "confirmed");
  if (!configAccount?.owner.equals(program)) throw new Error("CYCLE_POOL_CONFIG_OWNER");
  const config = ClmmConfigLayout.decode(configAccount.data);
  const pool = await PoolUtils.fetchComputeClmmInfo({ connection, rpcData: state, poolInfo: { ...metadata.pool, config: { ...metadata.pool.config, ...config, id: state.configId.toBase58() } } });
  const ticks = (await PoolUtils.fetchMultiplePoolTickArrays({ connection, poolKeys: [pool], batchRequest: false }))[leg.pool];
  const slot = await connection.getSlot("confirmed"), timestamp = await connection.getBlockTime(slot);
  if (timestamp === null || Math.abs(now() / 1000 - timestamp) > 60) throw new Error("CYCLE_CHAIN_CLOCK_UNAVAILABLE");
  if (!ticks || !pool.exBitmapInfo) throw new Error("CYCLE_POOL_TICKS_UNAVAILABLE");
  const zeroForOne = input.inputMint === state.mintA.toBase58();
  const startTick = TickArrayUtil.getTickArrayStartIndex(state.tickCurrent, state.tickSpacing);
  const simulated = swapInternal({ programId: program, poolId, poolInfo: state, configInfo: config, tickarrayBitmapExtension: pool.exBitmapInfo,
    tickArrays: Object.values(ticks).map(value => ({ address: value.address, value }))
      .filter(a => zeroForOne ? a.value.startTickIndex <= startTick : a.value.startTickIndex >= startTick)
      .sort((a, b) => zeroForOne ? b.value.startTickIndex - a.value.startTickIndex : a.value.startTickIndex - b.value.startTickIndex),
    amountSpecified: new BN(amount.toString()), sqrtPriceLimitX64: new BN(0), zeroForOne, isBaseInput: true, blockTimestamp: timestamp,
    // Only arrays actually traversed by the real SDK quote. No speculative extra arrays (packet
    // bloat for multi-leg bundles); price movement outside these arrays must fail atomically.
    includeExtraTickArrays: false });
  const quote = { allTrade: simulated.allTrade, expectedAmountOut: simulated.amountCalculated, remainingAccounts: simulated.accounts };
  if (!quote.allTrade || quote.expectedAmountOut.isZero()) throw new Error("CYCLE_NO_FULL_SIZE_ROUTE");
  const out = BigInt(quote.expectedAmountOut.toString());
  const slippageMinimum = out * BigInt(10000 - input.slippageBps) / 10000n;
  const required = rawAmount(input.minimumOutRaw ?? "0");
  const min = required > slippageMinimum ? required : slippageMinimum;
  if (min === 0n || min > out) throw new Error("CYCLE_ROUTE_MINIMUM_UNSATISFIABLE");
  const inputA = state.mintA.toBase58() === input.inputMint;
  const from = getAssociatedTokenAddressSync(new PublicKey(input.inputMint), new PublicKey(input.owner), false, inAccount!.owner);
  const to = getAssociatedTokenAddressSync(new PublicKey(input.outputMint), new PublicKey(input.owner), false, outAccount!.owner);
  const lookupTables: AddressLookupTableAccount[] = [];
  if (metadata.lookupTable && metadata.lookupTable !== PublicKey.default.toBase58()) {
    const key = new PublicKey(metadata.lookupTable), account = await connection.getAccountInfo(key, "confirmed");
    if (!account?.owner.equals(AddressLookupTableProgram.programId)) throw new Error("CYCLE_LOOKUP_OWNER");
    const state = AddressLookupTableAccount.deserialize(account.data);
    if (state.deactivationSlot !== 0xffffffffffffffffn || state.lastExtendedSlot >= slot) throw new Error("CYCLE_LOOKUP_INACTIVE_OR_UNWARMED");
    lookupTables.push(new AddressLookupTableAccount({ key, state }));
  }
  const instruction = ClmmInstrument.swapV2Instruction(program, new PublicKey(input.owner), poolId, state.configId, from, to,
    inputA ? state.vaultA : state.vaultB, inputA ? state.vaultB : state.vaultA, new PublicKey(input.inputMint), new PublicKey(input.outputMint),
    quote.remainingAccounts, state.observationId, new BN(amount.toString()), new BN(min.toString()), new BN(0), true, pool.exBitmapAccount);
  if (now() - start > input.maxAgeMs) throw new Error("CYCLE_QUOTE_EXPIRED_WHILE_BUILDING");
  return { pool: leg.pool, inputMint: input.inputMint, outputMint: input.outputMint, amountInRaw: amount.toString(), expectedOutRaw: out.toString(), minOutRaw: min.toString(), inputProgram: inAccount!.owner.toBase58(), outputProgram: outAccount!.owner.toBase58(), quotedAt: start, expiresAt: start + input.maxAgeMs, tvlUsd: metadata.pool.tvl, instruction, lookupTables };
}
