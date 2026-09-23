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
  BPS, JUPITER_V6_PROGRAM_ID, NAV_VAULT_PROGRAM_ID, USDC_LEG, authorityPda, keeperSwapIx, legAccount, legMint, legTokenProgram, legValue,
  mockPoolPda, mockSwapIx, updatePricesIx, withSlippage, type NavVaultState,
} from "./program.ts";
import { readNavVault, type NavConnection, type NavVaultSnapshot } from "./prepare.ts";
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

// ---------- tick ----------

export type KeeperTickResult = {
  indexId: string;
  dryRun: boolean;
  marks: { mint: string; price: string; venue: string }[];
  plan: { kind: string; mint: string; amountInRaw: string; valueUsdcRaw: string; reason: string }[];
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
  maxSwaps?: number;
}): Promise<KeeperTickResult> {
  const programId = input.programId ?? NAV_VAULT_PROGRAM_ID;
  const now = input.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
  let snapshot = await readNavVault(input.connection, input.indexId, programId, now());
  if (!snapshot) throw new Error(`No NAV vault for ${input.indexId}.`);
  if (!snapshot.state.keeper.equals(input.keeper)) throw new Error("This wallet is not the vault keeper.");
  const { state } = snapshot;
  const marks = await Promise.all(state.legs.map((leg, index) => input.marks({ index, mint: leg.mint, decimals: leg.decimals, tokenProgram: leg.tokenProgram })));
  if (marks.some(mark => mark.price <= 0n)) throw new Error("A mark is missing; refusing to post prices.");
  const result: KeeperTickResult = {
    indexId: input.indexId, dryRun: !input.execute,
    marks: marks.map((mark, i) => ({ mint: state.legs[i]!.mint.toBase58(), price: mark.price.toString(), venue: mark.venue })),
    plan: [], signatures: [], skipped: [],
  };
  const compile = async (instructions: TransactionInstruction[], tables: AddressLookupTableAccount[] = []) => {
    const latest = await input.connection.getLatestBlockhash("confirmed");
    return new VersionedTransaction(new TransactionMessage({ payerKey: input.keeper, recentBlockhash: latest.blockhash, instructions }).compileToV0Message(tables));
  };
  const priced: NavVaultSnapshot = { ...snapshot, state: { ...state, legs: state.legs.map((leg, i) => ({ ...leg, price: marks[i]!.price })) } };
  const planFor = (s: NavVaultSnapshot) => planRebalance({ legs: s.state.legs, usdc: s.usdcBalance, legBalances: s.legBalances, bufferBps: s.state.bufferBps });
  const initial = planFor(priced);
  result.plan = initial.map(a => ({ kind: a.kind, mint: state.legs[a.leg]!.mint.toBase58(), amountInRaw: a.amountInRaw.toString(), valueUsdcRaw: a.valueUsdcRaw.toString(), reason: a.reason }));
  if (!input.execute) return result;

  result.signatures.push({ step: "update_prices", signature: await input.execute(await compile([updatePricesIx(state, input.keeper, marks.map(m => m.price), programId)]), "update_prices") });
  await input.afterPrices?.();
  const authority = authorityPda(state.address, programId);
  for (let n = 0; n < (input.maxSwaps ?? state.legs.length * 2); n++) {
    snapshot = (await readNavVault(input.connection, input.indexId, programId, now()))!;
    const next = planFor(snapshot).find(action => !result.skipped.some(s => s.mint === state.legs[action.leg]!.mint.toBase58()));
    if (!next) break;
    const inMint = legMint(snapshot.state, next.inLeg), outMint = legMint(snapshot.state, next.outLeg);
    const built = await input.swaps({ vault: snapshot.state, authority, inMint, outMint, amountIn: next.amountInRaw, inTokenProgram: legTokenProgram(snapshot.state, next.inLeg), outTokenProgram: legTokenProgram(snapshot.state, next.outLeg) });
    if (!built) { result.skipped.push({ mint: state.legs[next.leg]!.mint.toBase58(), reason: "no route" }); continue; }
    const ix = keeperSwapIx({ vault: snapshot.state, keeper: input.keeper, inLeg: next.inLeg, outLeg: next.outLeg, amountIn: next.amountInRaw, minOut: built.minOut, swap: built.swap, programId });
    const tx = await compile([ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 }), ix], built.lookupTables);
    if (!fitsOnePacket(tx)) { result.skipped.push({ mint: state.legs[next.leg]!.mint.toBase58(), reason: "route too large for one transaction" }); continue; }
    const step = `${next.kind}:${state.legs[next.leg]!.mint.toBase58()}`;
    result.signatures.push({ step, signature: await input.execute(tx, step) });
  }
  const final = (await readNavVault(input.connection, input.indexId, programId, now()))!;
  result.after = { usdcRaw: final.usdcBalance.toString(), navRaw: final.nav.toString(), bufferBps: final.nav > 0n ? Number((final.usdcBalance * BPS) / final.nav) : 0 };
  return result;
}
