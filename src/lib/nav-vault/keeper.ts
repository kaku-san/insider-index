/**
 * NAV vault keeper: post marks (Raydium pool quote first, Jupiter if no pool; never Pyth/Hermes),
 * then move the vault toward its DB weights one swap per transaction while keeping a USDC exit
 * buffer (captain rule: 5% of vault value). Buys stop at the buffer floor (also enforced on chain);
 * a short buffer is topped up by selling the most overweight leg. The keeper never pays for fills:
 * every swap spends vault token accounts only, signed by the vault PDA inside `keeper_swap`.
 * No env, no `@/` aliases; network adapters are injected.
 */
import { AddressLookupTableAccount, ComputeBudgetProgram, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import {
  BPS, CLAIM_LEGS_PER_TX, JUPITER_V6_PROGRAM_ID, defaultProgramId, USDC_LEG, ata, authorityPda, claimInKindIx, crossRequestLegIx, fulfillSwapIx,
  keeperSwapIx, legAccount, legMint, legTokenProgram, legValue, mockPoolPda, mockSwapIx, settleRequestIx, updatePricesIx, withSlippage,
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

/** Pure plan. Values in USDC raw units at the posted marks. */
export function planRebalance(input: {
  legs: readonly { weightBps: number; price: bigint; decimals: number }[];
  usdc: bigint;
  legBalances: readonly bigint[];
  bufferBps: number;
  minTradeUsdcRaw?: bigint;
  marginBps?: number;
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
    if (deficit < minTrade || spendable < minTrade) continue;
    const buy = deficit < spendable ? deficit : spendable;
    actions.push({ kind: "buy", leg: i, inLeg: USDC_LEG, outLeg: i, amountInRaw: buy, valueUsdcRaw: buy, reason: "below target weight" });
    spendable -= buy;
  }
  return actions;
}

// ---------- adapters ----------

export type MarkSource = (leg: { index: number; mint: PublicKey; decimals: number; tokenProgram: PublicKey }) => Promise<{ price: bigint; venue: string }>;
export type SwapBuild = { swap: TransactionInstruction; minOut: bigint; venue: string; lookupTables: AddressLookupTableAccount[] };
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
    const quoteResponse = await fetchImpl(quoteUrl, { headers, signal: AbortSignal.timeout(15_000) });
    if (!quoteResponse.ok) return null;
    const quote = await quoteResponse.json() as { inAmount?: string; otherAmountThreshold?: string; inputMint?: string; outputMint?: string };
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
    return { swap, minOut, venue: "jupiter-v1", lookupTables };
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

/** 1232-byte packet and 64 loaded accounts (static + lookup) — the runtime limits a keeper swap must fit. */
export function fitsOnePacket(tx: VersionedTransaction): boolean {
  let bytes: number;
  try { bytes = tx.serialize().length; } catch { return false; }
  const loaded = tx.message.staticAccountKeys.length + tx.message.addressTableLookups.reduce((n, l) => n + l.writableIndexes.length + l.readonlyIndexes.length, 0);
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
export function planCycle(input: { snapshot: NavVaultSnapshot; requests: readonly NavRequest[]; minTradeUsdcRaw?: bigint }): CyclePlan {
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
  const fulfills = leftover.filter(item => !fulfilled.has(item.leg) && fulfilled.add(item.leg));
  const freeLegs = state.legs.map((_, i) => { const b = input.snapshot.legBalances[i] ?? 0n; return b > reserved[i]! ? b - reserved[i]! : 0n; });
  const swaps = planRebalance({ legs: state.legs, usdc: freeUsdc, legBalances: freeLegs, bufferBps: state.bufferBps, minTradeUsdcRaw: input.minTradeUsdcRaw }).filter(a => !fulfilled.has(a.leg));
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
  skipped: { mint: string; reason: string }[];
  after?: { usdcRaw: string; navRaw: string; bufferBps: number };
};

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
}): Promise<KeeperTickResult> {
  const programId = input.programId ?? defaultProgramId();
  const now = input.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
  let snapshot = await readNavVault(input.connection, input.indexId, programId, now());
  if (!snapshot) throw new Error(`No NAV vault for ${input.indexId}.`);
  if (!snapshot.state.keeper.equals(input.keeper)) throw new Error("This wallet is not the vault keeper.");
  const { state } = snapshot;
  if (state.paused) throw new Error("The vault is paused; the keeper does nothing.");
  const marks = await Promise.all(state.legs.map((leg, index) => input.marks({ index, mint: leg.mint, decimals: leg.decimals, tokenProgram: leg.tokenProgram })));
  if (marks.some(mark => mark.price <= 0n)) throw new Error("A mark is missing; refusing to post prices.");
  // The program rejects a >band move per update; say so plainly instead of sending a failing tx.
  for (const [i, leg] of state.legs.entries()) {
    const old = leg.price, next = marks[i]!.price;
    if (old > 0n && (next > old ? next - old : old - next) * BPS > old * BigInt(state.maxPriceMoveBps)) throw new Error(`Mark for ${leg.mint.toBase58()} moved more than ${state.maxPriceMoveBps} bps; admin override (admin_set_prices) required.`);
  }
  const requests = await readNavRequests(input.connection, state.address, undefined, programId);
  const result: KeeperTickResult = {
    indexId: input.indexId, dryRun: !input.execute,
    marks: marks.map((mark, i) => ({ mint: state.legs[i]!.mint.toBase58(), price: mark.price.toString(), venue: mark.venue })),
    plan: [], requests: { open: requests.length, crosses: 0, fulfills: 0, settled: 0, deliveredInKind: 0 }, signatures: [], skipped: [],
  };
  const priority = input.priorityMicroLamports ? [ComputeBudgetProgram.setComputeUnitPrice({ microLamports: input.priorityMicroLamports })] : [];
  const compile = async (instructions: TransactionInstruction[], tables: AddressLookupTableAccount[] = []) => {
    const latest = await input.connection.getLatestBlockhash("confirmed");
    return new VersionedTransaction(new TransactionMessage({ payerKey: input.keeper, recentBlockhash: latest.blockhash, instructions: [...priority, ...instructions] }).compileToV0Message(tables));
  };
  const vaultTables = state.lookupTable ? [(await input.connection.getAddressLookupTable(state.lookupTable)).value].filter((t): t is AddressLookupTableAccount => Boolean(t)) : [];
  const priced: NavVaultSnapshot = { ...snapshot, state: { ...state, legs: state.legs.map((leg, i) => ({ ...leg, price: marks[i]!.price })) } };
  const plan = planCycle({ snapshot: priced, requests });
  result.plan = [
    ...plan.crosses.map(c => ({ kind: "cross", mint: state.legs[c.leg]!.mint.toBase58(), amountInRaw: c.amount.toString(), valueUsdcRaw: c.usdc.toString(), reason: "exit settled from free USDC at mark" })),
    ...plan.swaps.map(a => ({ kind: a.kind, mint: state.legs[a.leg]!.mint.toBase58(), amountInRaw: a.amountInRaw.toString(), valueUsdcRaw: a.valueUsdcRaw.toString(), reason: a.reason })),
    ...plan.fulfills.map(f => ({ kind: "fulfill", mint: state.legs[f.leg]!.mint.toBase58(), amountInRaw: f.amount.toString(), valueUsdcRaw: legValue(priced.state.legs[f.leg]!, f.amount).toString(), reason: "sell a request slice to USDC" })),
  ];
  if (!input.execute) return result;

  result.signatures.push({ step: "update_prices", signature: await input.execute(await compile([updatePricesIx(state, input.keeper, marks.map(m => m.price), programId)], vaultTables), "update_prices") });
  if (input.maxSwaps === 0) return result;
  await input.afterPrices?.();
  const authority = authorityPda(state.address, programId);

  // 1. Crosses (batched, no venue).
  for (let k = 0; k < plan.crosses.length; k += 8) {
    const batch = plan.crosses.slice(k, k + 8);
    const sig = await input.execute(await compile(batch.map(c => crossRequestLegIx(state, input.keeper, c.request, c.leg, programId)), vaultTables), "cross");
    result.signatures.push({ step: `cross x${batch.length}`, signature: sig });
    result.requests.crosses += batch.length;
  }
  // At most one swap per leg this cycle.
  let swapCount = 0;
  const swappedLegs = new Set<number>();
  const trySwap = async (kind: string, leg: number, inLeg: number, outLeg: number, amountIn: bigint, request?: PublicKey) => {
    if (swappedLegs.has(leg) || swapCount >= (input.maxSwaps ?? state.legs.length * 2)) return false;
    snapshot = (await readNavVault(input.connection, input.indexId, programId, now()))!;
    const inMint = legMint(snapshot.state, inLeg), outMint = legMint(snapshot.state, outLeg);
    const built = await input.swaps({ vault: snapshot.state, authority, inMint, outMint, amountIn, inTokenProgram: legTokenProgram(snapshot.state, inLeg), outTokenProgram: legTokenProgram(snapshot.state, outLeg) });
    const mint = state.legs[leg]!.mint.toBase58();
    if (!built) { result.skipped.push({ mint, reason: "no route" }); return false; }
    const ix = request
      ? fulfillSwapIx({ vault: snapshot.state, keeper: input.keeper, request, inLeg, amountIn, minOut: built.minOut, swap: built.swap, programId })
      : keeperSwapIx({ vault: snapshot.state, keeper: input.keeper, inLeg, outLeg, amountIn, minOut: built.minOut, swap: built.swap, programId });
    const tx = await compile([ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 }), ix], [...vaultTables, ...built.lookupTables]);
    if (!fitsOnePacket(tx)) { result.skipped.push({ mint, reason: "route too large for one transaction" }); return false; }
    result.signatures.push({ step: `${kind}:${mint}`, signature: await input.execute!(tx, `${kind}:${mint}`) });
    swappedLegs.add(leg);
    swapCount += 1;
    return true;
  };
  // 2. Exits: request slices that could not be crossed are sold into their request (one per leg).
  const noRoute = new Set<string>();
  for (const f of plan.fulfills) {
    if (await trySwap("fulfill", f.leg, f.leg, USDC_LEG, f.amount, f.request)) result.requests.fulfills += 1;
    else if (result.skipped.some(s => s.mint === state.legs[f.leg]!.mint.toBase58() && s.reason === "no route")) noRoute.add(`${f.request.toBase58()}:${f.leg}`);
  }
  // 3. Rebalance on free balances for the remaining legs.
  for (const action of plan.swaps) await trySwap(action.kind, action.leg, action.inLeg, action.outLeg, action.amountInRaw);
  // 4. Settle converted requests; deliver unsellable legs in kind (only to existing owner accounts).
  const fresh = await readNavRequests(input.connection, state.address, undefined, programId);
  snapshot = (await readNavVault(input.connection, input.indexId, programId, now()))!;
  for (const request of fresh) {
    const stuck = request.legAmounts.map((a, leg) => ({ a, leg })).filter(x => x.a > 0n && noRoute.has(`${request.address.toBase58()}:${x.leg}`)).map(x => x.leg);
    if (stuck.length) {
      const infos = await input.connection.getMultipleAccountsInfo(stuck.map(leg => ata(request.owner, state.legs[leg]!.mint, state.legs[leg]!.tokenProgram)), "confirmed");
      const deliverable = stuck.filter((_, k) => Boolean(infos[k]));
      if (deliverable.length) {
        result.signatures.push({ step: "deliver in kind", signature: await input.execute(await compile([claimInKindIx(snapshot.state, input.keeper, request, deliverable.slice(0, CLAIM_LEGS_PER_TX), programId)], vaultTables), "deliver in kind") });
        result.requests.deliveredInKind += deliverable.length;
      }
      continue;
    }
    if (request.legAmounts.every(a => a === 0n) && request.usdcOwed >= request.minUsdc) {
      result.signatures.push({ step: "settle", signature: await input.execute(await compile([settleRequestIx(snapshot.state, input.keeper, request, programId)], vaultTables), "settle") });
      result.requests.settled += 1;
    }
  }
  const final = (await readNavVault(input.connection, input.indexId, programId, now()))!;
  const freeUsdcAfter = final.usdcBalance > final.state.reservedUsdc ? final.usdcBalance - final.state.reservedUsdc : 0n;
  result.after = { usdcRaw: freeUsdcAfter.toString(), navRaw: final.nav.toString(), bufferBps: final.nav > 0n ? Number((freeUsdcAfter * BPS) / final.nav) : 0 };
  return result;
}
