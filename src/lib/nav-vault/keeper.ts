/**
 * NAV vault keeper: post marks (Raydium pool quote first, Jupiter if no pool; never Pyth/Hermes),
 * then move the vault toward its DB weights one swap per transaction while keeping a USDC exit
 * buffer (captain rule: 5% of vault value). Buys stop at the buffer floor (also enforced on chain);
 * a short buffer is topped up by selling the most overweight leg. The keeper never pays for fills:
 * every swap spends vault token accounts only, signed by the vault PDA inside `keeper_swap`.
 * No env, no `@/` aliases; network adapters are injected.
 */
import { AddressLookupTableAccount, ComputeBudgetProgram, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction } from "@solana/spl-token";
import {
  BPS, CLAIM_LEGS_PER_TX, JUPITER_V6_PROGRAM_ID, defaultProgramId, USDC_LEG, ata, authorityPda, claimInKindIx, crossRequestLegIx, fulfillSwapIx,
  keeperSwapIx, legAccount, legMint, legTokenProgram, legValue, mockPoolPda, mockSwapIx, settleRequestIx, TOKEN_PROGRAM_ID, updatePricesIx, withSlippage,
  type NavRequest, type NavVaultState,
} from "./program.ts";
import { readNavRequests, readNavVault, type NavConnection, type NavVaultSnapshot } from "./prepare.ts";
import { fetchJupiterBuild } from "../index-vaults/jupiter-build.ts";

export const KEEPER_MIN_TRADE_USDC_RAW = 1_000_000n;
/** Extra headroom above the on-chain buffer floor so venue slippage cannot trip `BufferBreached`. */
export const KEEPER_BUFFER_MARGIN_BPS = 50;
export const JUPITER_ROUTE_DISCRIMINATORS = [
  [229, 23, 203, 151, 122, 227, 173, 42],
  [193, 32, 155, 51, 65, 214, 156, 129],
  [187, 100, 250, 204, 49, 196, 175, 20],
  [209, 152, 83, 147, 124, 254, 216, 233],
].map(bytes => Buffer.from(bytes).toString("hex"));

export type KeeperAction = { kind: "buy" | "sell"; leg: number; inLeg: number; outLeg: number; amountInRaw: bigint; valueUsdcRaw: bigint; reason: string };

// ---------- failure handling ----------

/** First retry delay after a failed leg swap; doubles per consecutive failure up to the max. */
export const KEEPER_DEFER_BASE_SECS = 120;
export const KEEPER_DEFER_MAX_SECS = 1_800;
/**
 * Per-process memory of failing swaps, keyed by vault/request + leg. A deferred leg is not retried
 * until `until` (unix seconds), so one unsellable leg cannot block other legs or vaults, or be retried
 * every cycle forever. `unsellable` = the venue cannot fill it inside the on-chain price bound.
 */
export type KeeperDeferral = { until: number; failures: number; reason: string; unsellable: boolean };
export type KeeperDeferrals = Map<string, KeeperDeferral>;
export const rebalanceDeferKey = (vault: PublicKey, kind: "buy" | "sell", leg: number) => `rebalance:${vault.toBase58()}:${kind}:${leg}`;
export const fulfillDeferKey = (request: PublicKey, leg: number) => `fulfill:${request.toBase58()}:${leg}`;
export function isDeferred(deferrals: KeeperDeferrals, key: string, now: number): boolean {
  const entry = deferrals.get(key);
  return Boolean(entry && entry.until > now);
}
export function recordFailure(deferrals: KeeperDeferrals, key: string, now: number, reason: string, unsellable: boolean): KeeperDeferral {
  const failures = (deferrals.get(key)?.failures ?? 0) + 1;
  const delay = Math.min(KEEPER_DEFER_MAX_SECS, KEEPER_DEFER_BASE_SECS * 2 ** (failures - 1));
  const entry = { until: now + delay, failures, reason, unsellable };
  deferrals.set(key, entry);
  return entry;
}

/**
 * Deterministic venue/bound failures (retrying the same swap cannot help soon): vault
 * `SwapPriceBound` 0x1788 / `SlippageExceeded` 0x1780, Jupiter `SlippageToleranceExceeded` 0x1771,
 * Raydium CLMM too-little-output 0x1786, plus keeper-side refusals. Everything else (RPC, blockhash,
 * stale marks) is transient.
 */
export function isUnsellableError(error: unknown): boolean {
  const text = error instanceof Error ? `${error.message}\n${(error as { logs?: string[] }).logs?.join("\n") ?? ""}` : String(error);
  return /custom program error: 0x(1788|1780|1771|1786)\b|\bcode: (6024|6016|6001|6022)\b|SwapPriceBound|SlippageExceeded|SlippageToleranceExceeded|no route|below the posted-price bound|route too large/i.test(text);
}

/** Mirror of the on-chain `SwapPriceBound` check at posted marks for a quoted output. */
export function withinPriceBound(vault: Pick<NavVaultState, "legs" | "maxSlippageBps">, inLeg: number, outLeg: number, amountIn: bigint, out: bigint): boolean {
  const value = (leg: number, amount: bigint) => leg === USDC_LEG ? amount : legValue(vault.legs[leg]!, amount);
  return value(outLeg, out) * BPS >= value(inLeg, amountIn) * (BPS - BigInt(vault.maxSlippageBps));
}

/** One-line reason: the Anchor error name or custom program error code when present (web3 puts them on later lines). */
export function errorText(error: unknown): string {
  const text = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").trim();
  const anchor = /Error Code: (\w+)/.exec(text)?.[1];
  const custom = /custom program error: (0x[0-9a-f]+)/i.exec(text)?.[1] ?? /InstructionErrorCustom \{ code: (\d+) \}/.exec(text)?.[1];
  const head = text.slice(0, 160);
  return anchor || custom ? `${anchor ?? ""}${anchor && custom ? " " : ""}${custom ? `(${custom})` : ""}: ${head}`.slice(0, 240) : head;
}

/** Pure plan. Values in USDC raw units at the posted marks. `skip` drops a (kind, leg) pair (deferred legs). */
export function planRebalance(input: {
  legs: readonly { weightBps: number; price: bigint; decimals: number }[];
  usdc: bigint;
  legBalances: readonly bigint[];
  bufferBps: number;
  minTradeUsdcRaw?: bigint;
  marginBps?: number;
  skip?: (kind: "buy" | "sell", leg: number) => boolean;
}): KeeperAction[] {
  const minTrade = input.minTradeUsdcRaw ?? KEEPER_MIN_TRADE_USDC_RAW;
  const margin = BigInt(input.marginBps ?? KEEPER_BUFFER_MARGIN_BPS);
  const values = input.legs.map((leg, i) => legValue(leg, input.legBalances[i] ?? 0n));
  const nav = values.reduce((a, b) => a + b, input.usdc);
  if (nav === 0n) return [];
  const bufferFloor = (nav * BigInt(input.bufferBps)) / BPS;
  const bufferTarget = (nav * (BigInt(input.bufferBps) + margin)) / BPS;
  const investable = nav - bufferTarget;
  const targets = input.legs.map(leg => (investable * BigInt(leg.weightBps)) / BPS);
  const actions: KeeperAction[] = [];
  if (input.usdc < bufferFloor) {
    let need = bufferTarget - input.usdc;
    const order = input.legs.map((_, i) => i).sort((a, b) => Number((values[b]! - targets[b]!) - (values[a]! - targets[a]!)));
    for (const i of order) {
      if (need <= 0n) break;
      if (input.skip?.("sell", i)) continue;
      const leg = input.legs[i]!;
      const sellValue = need < values[i]! ? need : values[i]!;
      if (sellValue < minTrade || leg.price === 0n) continue;
      let amount = (sellValue * 10n ** BigInt(leg.decimals) + leg.price - 1n) / leg.price;
      if (amount > input.legBalances[i]!) amount = input.legBalances[i]!;
      actions.push({ kind: "sell", leg: i, inLeg: i, outLeg: USDC_LEG, amountInRaw: amount, valueUsdcRaw: sellValue, reason: "USDC buffer below floor" });
      need -= sellValue;
    }
    return actions;
  }
  let spendable = input.usdc > bufferTarget ? input.usdc - bufferTarget : 0n;
  const order = input.legs.map((_, i) => i).sort((a, b) => Number((targets[b]! - values[b]!) - (targets[a]! - values[a]!)));
  for (const i of order) {
    const deficit = targets[i]! - values[i]!;
    if (deficit < minTrade || spendable < minTrade || input.skip?.("buy", i)) continue;
    const buy = deficit < spendable ? deficit : spendable;
    actions.push({ kind: "buy", leg: i, inLeg: USDC_LEG, outLeg: i, amountInRaw: buy, valueUsdcRaw: buy, reason: "below target weight" });
    spendable -= buy;
  }
  return actions;
}

// ---------- adapters ----------

export type MarkSource = (leg: { index: number; mint: PublicKey; decimals: number; tokenProgram: PublicKey }) => Promise<{ price: bigint; venue: string }>;
/** `expectedOut` = the venue's quoted output (before slippage), used to refuse swaps the on-chain price bound would reject. */
export type SwapBuild = { swap: TransactionInstruction; minOut: bigint; venue: string; lookupTables: AddressLookupTableAccount[]; expectedOut?: bigint };
export type SwapBuilder = (input: { vault: NavVaultState; authority: PublicKey; inMint: PublicKey; outMint: PublicKey; amountIn: bigint; inTokenProgram: PublicKey; outTokenProgram: PublicKey }) => Promise<SwapBuild | null>;

/** Mark = USDC in per whole leg token from an executable quote of `probeUsdcRaw` (ask side). */
export function markFromQuote(usdcInRaw: bigint, outRaw: bigint, decimals: number): bigint {
  if (outRaw <= 0n) throw new Error("Quote returned no output.");
  return (usdcInRaw * 10n ** BigInt(decimals)) / outRaw;
}

/** Devnet/test venue: marks read from the mock pool state, the same venue the keeper trades on. */
export function mockVenue(connection: NavConnection, usdcMint: PublicKey): { marks: MarkSource; swaps: SwapBuilder } {
  const price = async (mint: PublicKey) => {
    const pool = await connection.getAccountInfo(mockPoolPda(mint, usdcMint), "confirmed");
    if (!pool || pool.data.length < 107) throw new Error(`No mock pool for ${mint.toBase58()}.`);
    return Buffer.from(pool.data).readBigUInt64LE(96);
  };
  return {
    marks: async leg => ({ price: await price(leg.mint), venue: "mock-pool" }),
    swaps: async input => {
      const stock = input.inMint.equals(usdcMint) ? input.outMint : input.inMint;
      const p = await price(stock);
      const decimals = input.vault.legs.find(leg => leg.mint.equals(stock))!.decimals;
      const scale = 10n ** BigInt(decimals);
      const expected = input.inMint.equals(usdcMint) ? (input.amountIn * scale) / p : (input.amountIn * p) / scale;
      const minOut = withSlippage(expected, 50);
      return {
        venue: "mock-swap",
        minOut,
        expectedOut: expected,
        lookupTables: [],
        swap: mockSwapIx({
          user: input.authority, baseMint: stock, quoteMint: usdcMint, inMint: input.inMint, outMint: input.outMint,
          userSrc: legAccount(input.vault, input.inMint.equals(usdcMint) ? USDC_LEG : input.vault.legs.findIndex(l => l.mint.equals(input.inMint))),
          userDst: legAccount(input.vault, input.outMint.equals(usdcMint) ? USDC_LEG : input.vault.legs.findIndex(l => l.mint.equals(input.outMint))),
          amountIn: input.amountIn, minOut, inTokenProgram: input.inTokenProgram, outTokenProgram: input.outTokenProgram,
        }),
      };
    },
  };
}

/** Mainnet venue: Jupiter `/swap/v2/build` with the vault authority PDA as taker; only the route instruction is wrapped. */
export function jupiterSwapBuilder(options: { env?: { JUPITER_API_KEY?: string }; fetchImpl?: typeof fetch; slippageBps?: number } = {}): SwapBuilder {
  return async input => {
    const built = await fetchJupiterBuild({
      inputMint: input.inMint.toBase58(), outputMint: input.outMint.toBase58(), amountRaw: input.amountIn.toString(),
      taker: input.authority.toBase58(), env: options.env, fetchImpl: options.fetchImpl,
    });
    if (!built) return null;
    const routes = built.instructions.filter(ix => ix.programId.equals(JUPITER_V6_PROGRAM_ID) && JUPITER_ROUTE_DISCRIMINATORS.includes(Buffer.from(ix.data.subarray(0, 8)).toString("hex")));
    if (routes.length !== 1) return null;
    return { swap: routes[0]!, minOut: BigInt(built.minOutRaw), venue: "jupiter", lookupTables: built.lookupTables };
  };
}

/** Jupiter DEX labels that accept being invoked via CPI from the vault program (no top-level-only prop AMMs). */
export const JUPITER_CPI_SAFE_DEXES = ["Raydium CLMM", "Raydium CP", "Raydium", "Whirlpool", "Meteora DLMM", "Meteora DAMM v2", "Meteora", "Orca V2"];

/**
 * Jupiter v1 `/quote` + `/swap-instructions` (keyless `lite-api.jup.ag`, or `api.jup.ag` with a key).
 * Verified read-only on mainnet: with the vault authority PDA as `userPublicKey` it returns a
 * `shared_accounts_route` whose only signer is the PDA. Setup (ATA create, payer = PDA) is dropped:
 * vault token accounts already exist.
 */
export function jupiterV1SwapBuilder(options: {
  connection: Pick<NavConnection, "getAddressLookupTable">;
  baseUrl?: string;
  apiKey?: string;
  slippageBps?: number;
  fetchImpl?: typeof fetch;
  /** Jupiter DEX labels allowed in the route (default: CPI-safe AMMs). */
  dexes?: string[];
}): SwapBuilder {
  const base = options.baseUrl ?? (options.apiKey ? "https://api.jup.ag/swap/v1" : "https://lite-api.jup.ag/swap/v1");
  const fetchImpl = options.fetchImpl ?? fetch;
  const headers: Record<string, string> = { Accept: "application/json", ...(options.apiKey ? { "x-api-key": options.apiKey } : {}) };
  return async input => {
    const quoteUrl = new URL(`${base}/quote`);
    quoteUrl.searchParams.set("inputMint", input.inMint.toBase58());
    quoteUrl.searchParams.set("outputMint", input.outMint.toBase58());
    quoteUrl.searchParams.set("amount", input.amountIn.toString());
    quoteUrl.searchParams.set("slippageBps", String(options.slippageBps ?? 50));
    quoteUrl.searchParams.set("swapMode", "ExactIn");
    // CPI-safe venues only: several prop AMMs (e.g. Quantum, HumidiFi, SolFi) reject being called via CPI.
    quoteUrl.searchParams.set("dexes", (options.dexes ?? JUPITER_CPI_SAFE_DEXES).join(","));
    const quoteResponse = await fetchImpl(quoteUrl, { headers, signal: AbortSignal.timeout(15_000) });
    if (!quoteResponse.ok) return null;
    const quote = await quoteResponse.json() as { inAmount?: string; outAmount?: string; otherAmountThreshold?: string; inputMint?: string; outputMint?: string };
    if (quote.inputMint !== input.inMint.toBase58() || quote.outputMint !== input.outMint.toBase58() || quote.inAmount !== input.amountIn.toString()) return null;
    const response = await fetchImpl(`${base}/swap-instructions`, {
      method: "POST", headers: { ...headers, "Content-Type": "application/json" }, signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({ quoteResponse: quote, userPublicKey: input.authority.toBase58(), wrapAndUnwrapSol: false, useSharedAccounts: true }),
    });
    if (!response.ok) return null;
    const body = await response.json() as { swapInstruction?: { programId: string; data: string; accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[] }; addressLookupTableAddresses?: string[] };
    const raw = body.swapInstruction;
    if (!raw || raw.programId !== JUPITER_V6_PROGRAM_ID.toBase58()) return null;
    const data = Buffer.from(raw.data, "base64");
    if (!JUPITER_ROUTE_DISCRIMINATORS.includes(data.subarray(0, 8).toString("hex"))) return null;
    if (raw.accounts.some(meta => meta.isSigner && meta.pubkey !== input.authority.toBase58())) return null;
    const swap = new TransactionInstruction({ programId: JUPITER_V6_PROGRAM_ID, data, keys: raw.accounts.map(meta => ({ pubkey: new PublicKey(meta.pubkey), isSigner: meta.isSigner, isWritable: meta.isWritable })) });
    const lookupTables = (await Promise.all((body.addressLookupTableAddresses ?? []).map(async key => (await options.connection.getAddressLookupTable(new PublicKey(key))).value))).filter((t): t is AddressLookupTableAccount => Boolean(t));
    const minOut = BigInt(quote.otherAmountThreshold ?? "0");
    if (minOut <= 0n) return null;
    return { swap, minOut, venue: "jupiter-v1", lookupTables, ...(quote.outAmount ? { expectedOut: BigInt(quote.outAmount) } : {}) };
  };
}

/** Try each venue in order (e.g. Jupiter v2 build with a key, then v1 swap-instructions). */
export function firstRoute(...builders: SwapBuilder[]): SwapBuilder {
  return async input => {
    for (const build of builders) {
      try { const built = await build(input); if (built) return built; } catch (error) { if (error instanceof Error && /API key was rejected/.test(error.message)) throw error; }
    }
    return null;
  };
}

/** Packet size and loaded-account limits a keeper swap must fit. */
export function fitsOnePacket(tx: VersionedTransaction): boolean {
  let bytes: number;
  try { bytes = tx.serialize().length; } catch { return false; }
  const loaded = tx.message.staticAccountKeys.length + tx.message.addressTableLookups.reduce((n, l) => n + l.writableIndexes.length + l.readonlyIndexes.length, 0);
  // 1232-byte packet and the 64-account lock limit ("Transaction locked too many accounts" on mainnet).
  return bytes <= 1232 && loaded <= 64;
}

// ---------- cycle plan ----------

export type CyclePlan = {
  crosses: { request: PublicKey; leg: number; amount: bigint; usdc: bigint }[];
  swaps: KeeperAction[];
  fulfills: { request: PublicKey; leg: number; amount: bigint }[];
};

/**
 * One keeper cycle, netted: open request slices are first crossed against free vault USDC at the
 * posted marks (exits settled from the buffer, no venue); the rebalance then runs on the resulting
 * FREE balances, so deposits and withdrawals net out before any trade; at most ONE swap per leg per
 * cycle. Exits have priority: a request slice that could not be crossed is sold with `fulfill_swap`
 * (one per leg, oldest request first) and that leg gets no rebalance swap this cycle.
 */
export function planCycle(input: {
  snapshot: NavVaultSnapshot;
  requests: readonly NavRequest[];
  minTradeUsdcRaw?: bigint;
  /** Deferred rebalance swaps (a failing leg is skipped; e.g. the next overweight leg tops up the buffer). */
  skipSwap?: (kind: "buy" | "sell", leg: number) => boolean;
  /** Deferred request-leg sales (the slot goes to the next request on that leg). */
  skipFulfill?: (request: PublicKey, leg: number) => boolean;
}): CyclePlan {
  const { state } = input.snapshot;
  let freeUsdc = input.snapshot.usdcBalance > state.reservedUsdc ? input.snapshot.usdcBalance - state.reservedUsdc : 0n;
  const reserved = state.legs.map(leg => leg.reserved);
  const crosses: CyclePlan["crosses"] = [];
  const leftover: { request: PublicKey; leg: number; amount: bigint }[] = [];
  for (const request of input.requests) {
    for (const [leg, amount] of request.legAmounts.entries()) {
      if (amount === 0n) continue;
      const usdc = legValue(state.legs[leg]!, amount);
      if (usdc <= freeUsdc) {
        crosses.push({ request: request.address, leg, amount, usdc });
        freeUsdc -= usdc;
        reserved[leg] = reserved[leg]! > amount ? reserved[leg]! - amount : 0n;
      } else leftover.push({ request: request.address, leg, amount });
    }
  }
  // Exits first: one fulfill per leg (oldest request first); rebalance swaps only on the other legs.
  const fulfilled = new Set<number>();
  const fulfills = leftover.filter(item => !input.skipFulfill?.(item.request, item.leg) && !fulfilled.has(item.leg) && fulfilled.add(item.leg));
  const freeLegs = state.legs.map((_, i) => { const b = input.snapshot.legBalances[i] ?? 0n; return b > reserved[i]! ? b - reserved[i]! : 0n; });
  const swaps = planRebalance({ legs: state.legs, usdc: freeUsdc, legBalances: freeLegs, bufferBps: state.bufferBps, minTradeUsdcRaw: input.minTradeUsdcRaw, skip: input.skipSwap }).filter(a => !fulfilled.has(a.leg));
  return { crosses, swaps, fulfills };
}

// ---------- tick ----------


export type KeeperTickResult = {
  indexId: string;
  dryRun: boolean;
  marks: { mint: string; price: string; venue: string }[];
  plan: { kind: string; mint: string; amountInRaw: string; valueUsdcRaw: string; reason: string }[];
  requests: { open: number; crosses: number; fulfills: number; settled: number; deliveredInKind: number };
  signatures: { step: string; signature: string }[];
  /** Swaps not sent or failed this cycle; `retryAt` (unix seconds) when the leg is deferred. */
  skipped: { mint: string; reason: string; step?: string; retryAt?: number }[];
  /** Non-swap steps (cross, settle, in-kind delivery) that failed; the rest of the cycle still ran. */
  errors: { step: string; error: string }[];
  after?: { usdcRaw: string; navRaw: string; bufferBps: number };
};

/** Owner token accounts to create (idempotently, keeper pays rent) before an in-kind delivery. */
function ownerAccountIxs(keeper: PublicKey, state: NavVaultState, owner: PublicKey, legs: readonly number[]): TransactionInstruction[] {
  return [
    createAssociatedTokenAccountIdempotentInstruction(keeper, ata(owner, state.usdcMint), owner, state.usdcMint, TOKEN_PROGRAM_ID),
    ...legs.map(i => { const leg = state.legs[i]!; return createAssociatedTokenAccountIdempotentInstruction(keeper, ata(owner, leg.mint, leg.tokenProgram), owner, leg.mint, leg.tokenProgram); }),
  ];
}

export async function keeperTick(input: {
  connection: NavConnection;
  indexId: string;
  keeper: PublicKey;
  marks: MarkSource;
  swaps: SwapBuilder;
  /** Sign + send + confirm one transaction; omitted = dry run (nothing is signed). */
  execute?: (tx: VersionedTransaction, step: string) => Promise<string>;
  /** Wait until the posted marks are usable (at least one slot old) before trading. */
  afterPrices?: () => Promise<void>;
  programId?: PublicKey;
  nowSeconds?: () => number;
  /** 0 = marks only (no crosses, swaps, fulfills or settles). */
  maxSwaps?: number;
  /** Optional compute-unit price for every keeper transaction (mainnet landing). */
  priorityMicroLamports?: number;
  /** Smallest rebalance trade in USDC raw units (default $1). */
  minTradeUsdcRaw?: bigint;
  /** Multi-vault cycles: prices were already posted for this vault in a batched transaction. */
  pricesPosted?: boolean;
  /** Multi-vault cycles: requests read once for the whole program (null = unreadable this cycle). */
  requestsOverride?: NavRequest[] | null;
  /** Failing-leg memory across cycles (pass the same map every cycle); omitted = per-tick only. */
  deferrals?: KeeperDeferrals;
  /** Lookup-table cache across cycles (vault LUTs rarely change), keyed by base58 address. */
  lookupTables?: Map<string, AddressLookupTableAccount>;
}): Promise<KeeperTickResult> {
  const programId = input.programId ?? defaultProgramId();
  const now = input.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
  const deferrals = input.deferrals ?? new Map<string, KeeperDeferral>();
  let snapshot = await readNavVault(input.connection, input.indexId, programId, now());
  if (!snapshot) throw new Error(`No NAV vault for ${input.indexId}.`);
  if (!snapshot.state.keeper.equals(input.keeper)) throw new Error("This wallet is not the vault keeper.");
  const { state } = snapshot;
  if (state.paused) throw new Error("The vault is paused; the keeper does nothing.");
  // Sequential quotes: parallel Raydium tick-array reads burst the RPC rate limit (429s).
  const marks: { price: bigint; venue: string }[] = [];
  for (const [index, leg] of state.legs.entries()) marks.push(await input.marks({ index, mint: leg.mint, decimals: leg.decimals, tokenProgram: leg.tokenProgram }));
  if (marks.some(mark => mark.price <= 0n)) throw new Error("A mark is missing; refusing to post prices.");
  // The program rejects a >band move per update; say so plainly instead of sending a failing tx.
  for (const [i, leg] of state.legs.entries()) {
    const old = leg.price, next = marks[i]!.price;
    if (old > 0n && (next > old ? next - old : old - next) * BPS > old * BigInt(state.maxPriceMoveBps)) throw new Error(`Mark for ${leg.mint.toBase58()} moved more than ${state.maxPriceMoveBps} bps; admin override (admin_set_prices) required.`);
  }
  // Request discovery uses getProgramAccounts; an overloaded RPC index must not stop marks or rebalancing.
  let requests: NavRequest[] = [];
  let requestsReadable = true;
  if (input.requestsOverride !== undefined) {
    requestsReadable = input.requestsOverride !== null;
    requests = (input.requestsOverride ?? []).filter(request => request.vault.equals(state.address));
  } else {
    try { requests = await readNavRequests(input.connection, state.address, undefined, programId); } catch { requestsReadable = false; }
  }
  const result: KeeperTickResult = {
    indexId: input.indexId, dryRun: !input.execute,
    marks: marks.map((mark, i) => ({ mint: state.legs[i]!.mint.toBase58(), price: mark.price.toString(), venue: mark.venue })),
    plan: [], requests: { open: requests.length, crosses: 0, fulfills: 0, settled: 0, deliveredInKind: 0 }, signatures: [], skipped: [], errors: [],
  };
  const priority = input.priorityMicroLamports ? [ComputeBudgetProgram.setComputeUnitPrice({ microLamports: input.priorityMicroLamports })] : [];
  const compile = async (instructions: TransactionInstruction[], tables: AddressLookupTableAccount[] = []) => {
    const latest = await input.connection.getLatestBlockhash("confirmed");
    return new VersionedTransaction(new TransactionMessage({ payerKey: input.keeper, recentBlockhash: latest.blockhash, instructions: [...priority, ...instructions] }).compileToV0Message(tables));
  };
  const vaultTables = state.lookupTable ? [await cachedLookupTable(input.connection, state.lookupTable, input.lookupTables)].filter((t): t is AddressLookupTableAccount => Boolean(t)) : [];
  const priced: NavVaultSnapshot = { ...snapshot, state: { ...state, legs: state.legs.map((leg, i) => ({ ...leg, price: marks[i]!.price })) } };
  const plan = planCycle({
    snapshot: priced, requests, minTradeUsdcRaw: input.minTradeUsdcRaw,
    skipSwap: (kind, leg) => isDeferred(deferrals, rebalanceDeferKey(state.address, kind, leg), now()),
    skipFulfill: (request, leg) => isDeferred(deferrals, fulfillDeferKey(request, leg), now()),
  });
  result.plan = [
    ...plan.crosses.map(c => ({ kind: "cross", mint: state.legs[c.leg]!.mint.toBase58(), amountInRaw: c.amount.toString(), valueUsdcRaw: c.usdc.toString(), reason: "exit settled from free USDC at mark" })),
    ...plan.swaps.map(a => ({ kind: a.kind, mint: state.legs[a.leg]!.mint.toBase58(), amountInRaw: a.amountInRaw.toString(), valueUsdcRaw: a.valueUsdcRaw.toString(), reason: a.reason })),
    ...plan.fulfills.map(f => ({ kind: "fulfill", mint: state.legs[f.leg]!.mint.toBase58(), amountInRaw: f.amount.toString(), valueUsdcRaw: legValue(priced.state.legs[f.leg]!, f.amount).toString(), reason: "sell a request slice to USDC" })),
  ];
  for (const [key, entry] of deferrals) {
    if (entry.until <= now() || !key.includes(state.address.toBase58())) continue;
    const [, , kind, leg] = key.split(":");
    result.skipped.push({ mint: state.legs[Number(leg)]?.mint.toBase58() ?? "?", step: `${kind} (deferred)`, reason: entry.reason, retryAt: entry.until });
  }
  if (!input.execute) return result;
  const execute = input.execute;
  // A failing step is recorded and the cycle continues: later legs, settles and other vaults still run.
  const attempt = async (step: string, run: () => Promise<string>) => {
    try { const signature = await run(); result.signatures.push({ step, signature }); return true; }
    catch (error) { result.errors.push({ step, error: errorText(error) }); return false; }
  };

  if (!input.pricesPosted) {
    result.signatures.push({ step: "update_prices", signature: await execute(await compile([updatePricesIx(state, input.keeper, marks.map(m => m.price), programId)], vaultTables), "update_prices") });
    if (input.maxSwaps === 0) return result;
    await input.afterPrices?.();
  } else if (input.maxSwaps === 0) return result;
  const authority = authorityPda(state.address, programId);

  // 1. Crosses (batched, no venue).
  for (let k = 0; k < plan.crosses.length; k += 8) {
    const batch = plan.crosses.slice(k, k + 8);
    if (await attempt(`cross x${batch.length}`, async () => execute(await compile(batch.map(c => crossRequestLegIx(state, input.keeper, c.request, c.leg, programId)), vaultTables), "cross"))) result.requests.crosses += batch.length;
  }
  // At most one swap per leg this cycle. A swap that cannot fill inside the on-chain price bound, or
  // fails for any reason, is skipped and deferred with backoff; it never aborts the cycle.
  let swapCount = 0;
  const swappedLegs = new Set<number>();
  type SwapOutcome = { ok: true } | { ok: false; unsellable: boolean };
  const trySwap = async (kind: string, leg: number, inLeg: number, outLeg: number, amountIn: bigint, deferKey: string, request?: PublicKey): Promise<SwapOutcome> => {
    if (swappedLegs.has(leg) || swapCount >= (input.maxSwaps ?? state.legs.length * 2)) return { ok: false, unsellable: false };
    const mint = state.legs[leg]!.mint.toBase58();
    const step = `${kind}:${mint}`;
    const fail = (reason: string, unsellable: boolean): SwapOutcome => {
      const entry = recordFailure(deferrals, deferKey, now(), reason, unsellable);
      result.skipped.push({ mint, step: kind, reason, retryAt: entry.until });
      return { ok: false, unsellable };
    };
    try {
      snapshot = (await readNavVault(input.connection, input.indexId, programId, now()))!;
      const inMint = legMint(snapshot.state, inLeg), outMint = legMint(snapshot.state, outLeg);
      const built = await input.swaps({ vault: snapshot.state, authority, inMint, outMint, amountIn, inTokenProgram: legTokenProgram(snapshot.state, inLeg), outTokenProgram: legTokenProgram(snapshot.state, outLeg) });
      if (!built) return fail("no route", true);
      // Refuse before sending when the venue quote cannot pass the on-chain posted-price bound.
      const quotedOut = built.expectedOut ?? built.minOut;
      if (!withinPriceBound(snapshot.state, inLeg, outLeg, amountIn, quotedOut)) return fail(`quote below the posted-price bound (${state.maxSlippageBps} bps)`, true);
      const ix = request
        ? fulfillSwapIx({ vault: snapshot.state, keeper: input.keeper, request, inLeg, amountIn, minOut: built.minOut, swap: built.swap, programId })
        : keeperSwapIx({ vault: snapshot.state, keeper: input.keeper, inLeg, outLeg, amountIn, minOut: built.minOut, swap: built.swap, programId });
      const tx = await compile([ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 }), ix], [...vaultTables, ...built.lookupTables]);
      if (!fitsOnePacket(tx)) return fail("route too large for one transaction", true);
      result.signatures.push({ step, signature: await execute(tx, step) });
    } catch (error) {
      return fail(errorText(error), isUnsellableError(error));
    }
    deferrals.delete(deferKey);
    swappedLegs.add(leg);
    swapCount += 1;
    return { ok: true };
  };
  // 2. Exits: request slices that could not be crossed are sold into their request (one per leg).
  const unsellableNow = new Set<string>();
  for (const f of plan.fulfills) {
    const outcome = await trySwap("fulfill", f.leg, f.leg, USDC_LEG, f.amount, fulfillDeferKey(f.request, f.leg), f.request);
    if (outcome.ok) result.requests.fulfills += 1;
    else if (outcome.unsellable) unsellableNow.add(fulfillDeferKey(f.request, f.leg));
  }
  // 3. Rebalance on free balances for the remaining legs.
  for (const action of plan.swaps) await trySwap(action.kind, action.leg, action.inLeg, action.outLeg, action.amountInRaw, rebalanceDeferKey(state.address, action.kind, action.leg));
  // 4. Settle converted requests. Captain rule: a slice that cannot be sold is delivered in kind,
  //    pro-rata, to the request owner (keeper creates the owner's token accounts; only the owner is paid).
  let fresh: NavRequest[] = [];
  if (requestsReadable && result.requests.open > 0) { try { fresh = await readNavRequests(input.connection, state.address, undefined, programId); } catch { fresh = []; } }
  let current: NavVaultState = snapshot?.state ?? state;
  try { current = (await readNavVault(input.connection, input.indexId, programId, now()))?.state ?? current; } catch (error) { result.errors.push({ step: "read vault", error: errorText(error) }); }
  for (const request of fresh) {
    const open = request.legAmounts.map((amount, leg) => ({ amount, leg })).filter(item => item.amount > 0n).map(item => item.leg);
    const timedOut = now() >= request.claimableAt;
    const stuck = open.filter(leg => {
      const key = fulfillDeferKey(request.address, leg);
      const entry = deferrals.get(key);
      return unsellableNow.has(key) || Boolean(entry?.unsellable) || (timedOut && Boolean(entry));
    });
    // Deliver only once every remaining leg is unsellable: the claim then pays the USDC owed and closes the request.
    if (open.length && stuck.length === open.length) {
      const stepLegs = 4;
      for (let k = 0; k < stuck.length; k += stepLegs) {
        const legs = stuck.slice(k, k + stepLegs);
        const ok = await attempt("deliver in kind", async () => execute(await compile([
          ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
          ...ownerAccountIxs(input.keeper, current, request.owner, legs),
          claimInKindIx(current, input.keeper, request, legs.slice(0, CLAIM_LEGS_PER_TX), programId),
        ], vaultTables), "deliver in kind"));
        if (!ok) break;
        result.requests.deliveredInKind += legs.length;
        for (const leg of legs) deferrals.delete(fulfillDeferKey(request.address, leg));
      }
      continue;
    }
    if (!open.length && request.usdcOwed >= request.minUsdc) {
      if (await attempt("settle", async () => execute(await compile([settleRequestIx(current, input.keeper, request, programId)], vaultTables), "settle"))) result.requests.settled += 1;
    }
  }
  const final = await readNavVault(input.connection, input.indexId, programId, now()).catch(() => null);
  if (final) {
    const freeUsdcAfter = final.usdcBalance > final.state.reservedUsdc ? final.usdcBalance - final.state.reservedUsdc : 0n;
    result.after = { usdcRaw: freeUsdcAfter.toString(), navRaw: final.nav.toString(), bufferBps: final.nav > 0n ? Number((freeUsdcAfter * BPS) / final.nav) : 0 };
  }
  return result;
}

async function cachedLookupTable(connection: NavConnection, key: PublicKey, cache?: Map<string, AddressLookupTableAccount>): Promise<AddressLookupTableAccount | null> {
  const hit = cache?.get(key.toBase58());
  if (hit) return hit;
  const table = (await connection.getAddressLookupTable(key)).value;
  if (table) cache?.set(key.toBase58(), table);
  return table;
}

// ---------- multi-vault cycle ----------

export type KeeperCycleResult = {
  vaults: { indexId: string; ok: boolean; error?: string; result?: KeeperTickResult }[];
  priceTransactions: string[];
  marks: number;
};

/** A mark source that quotes each mint once per cycle (vaults share legs such as NVDA or MSFT). */
export function cachedMarks(source: MarkSource): MarkSource {
  const cache = new Map<string, Promise<{ price: bigint; venue: string }>>();
  return leg => {
    const key = leg.mint.toBase58();
    if (!cache.has(key)) cache.set(key, source(leg));
    return cache.get(key)!;
  };
}

/**
 * One keeper cycle across many vaults: quote each mint once, post every vault's marks in as few
 * transactions as fit (several `update_prices` per tx), wait a slot, then run each vault's netted
 * cycle (crosses, exits, rebalance, settles) without re-posting prices. A failing vault never stops
 * the others. Open requests are read once for the whole program.
 */
export async function keeperCycleAll(input: {
  connection: NavConnection;
  indexIds: readonly string[];
  keeper: PublicKey;
  marks: MarkSource;
  swaps: SwapBuilder;
  execute?: (tx: VersionedTransaction, step: string) => Promise<string>;
  afterPrices?: () => Promise<void>;
  programId?: PublicKey;
  nowSeconds?: () => number;
  priorityMicroLamports?: number;
  minTradeUsdcRaw?: bigint;
  deferrals?: KeeperDeferrals;
  lookupTables?: Map<string, AddressLookupTableAccount>;
}): Promise<KeeperCycleResult> {
  const programId = input.programId ?? defaultProgramId();
  const now = input.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
  input = { ...input, deferrals: input.deferrals ?? new Map(), lookupTables: input.lookupTables ?? new Map() };
  const marks = cachedMarks(input.marks);
  const result: KeeperCycleResult = { vaults: [], priceTransactions: [], marks: 0 };
  type Ready = { indexId: string; state: NavVaultState; prices: bigint[]; table: AddressLookupTableAccount | null };
  const ready: Ready[] = [];
  for (const indexId of input.indexIds) {
    try {
      const snapshot = await readNavVault(input.connection, indexId, programId, now());
      if (!snapshot) throw new Error("no NAV vault");
      const { state } = snapshot;
      if (!state.keeper.equals(input.keeper)) throw new Error("this wallet is not the vault keeper");
      if (state.paused) throw new Error("paused");
      const prices: bigint[] = [];
      for (const [index, leg] of state.legs.entries()) prices.push((await marks({ index, mint: leg.mint, decimals: leg.decimals, tokenProgram: leg.tokenProgram })).price);
      if (prices.some(p => p <= 0n)) throw new Error("a mark is missing");
      for (const [i, leg] of state.legs.entries()) {
        const old = leg.price, next = prices[i]!;
        if (old > 0n && (next > old ? next - old : old - next) * BPS > old * BigInt(state.maxPriceMoveBps)) throw new Error(`mark for ${leg.mint.toBase58()} moved more than ${state.maxPriceMoveBps} bps; admin override required`);
      }
      const table = state.lookupTable ? await cachedLookupTable(input.connection, state.lookupTable, input.lookupTables) : null;
      ready.push({ indexId, state, prices, table });
    } catch (error) {
      result.vaults.push({ indexId, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
  result.marks = ready.reduce((n, r) => n + r.prices.length, 0);
  if (!input.execute) {
    for (const r of ready) result.vaults.push({ indexId: r.indexId, ok: true, result: await keeperTick({ ...input, indexId: r.indexId, marks: async leg => ({ price: r.prices[leg.index]!, venue: "cycle" }), execute: undefined }) });
    return result;
  }
  // Batched price posts: pack as many update_prices as fit one transaction.
  const priority = input.priorityMicroLamports ? [ComputeBudgetProgram.setComputeUnitPrice({ microLamports: input.priorityMicroLamports })] : [];
  const build = async (batch: Ready[]) => {
    const latest = await input.connection.getLatestBlockhash("confirmed");
    const instructions = [ComputeBudgetProgram.setComputeUnitLimit({ units: Math.min(1_400_000, 60_000 * batch.length + 20_000) }), ...priority, ...batch.map(r => updatePricesIx(r.state, input.keeper, r.prices, programId))];
    return new VersionedTransaction(new TransactionMessage({ payerKey: input.keeper, recentBlockhash: latest.blockhash, instructions }).compileToV0Message(batch.flatMap(r => r.table ? [r.table] : [])));
  };
  let batch: Ready[] = [];
  const flush = async () => {
    if (!batch.length) return;
    result.priceTransactions.push(await input.execute!(await build(batch), `update_prices x${batch.length}`));
    batch = [];
  };
  for (const r of ready) {
    const candidate = [...batch, r];
    if (batch.length && !fitsOnePacket(await build(candidate))) await flush();
    batch.push(r);
  }
  await flush();
  await input.afterPrices?.();
  let requests: NavRequest[] | null;
  try { requests = await readNavRequests(input.connection, null, undefined, programId); } catch { requests = null; }
  for (const r of ready) {
    try {
      const tick = await keeperTick({ ...input, indexId: r.indexId, marks: async leg => ({ price: r.prices[leg.index]!, venue: "cycle" }), pricesPosted: true, requestsOverride: requests });
      result.vaults.push({ indexId: r.indexId, ok: true, result: tick });
    } catch (error) {
      result.vaults.push({ indexId: r.indexId, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return result;
}
