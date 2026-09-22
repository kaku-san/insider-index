import { PublicKey, type Connection } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getMint, unpackAccount } from "@solana/spl-token";
import { getRebalanceIntentPda } from "@symmetry-hq/sdk/dist/instructions/pda.js";
import { RebalanceAction, RebalanceType, type UIRebalanceIntent } from "@symmetry-hq/sdk/dist/layouts/intents/rebalanceIntent.js";
import { getHeliusRpcUrl } from "../helius.ts";
import type { IndexSharePosition, Network, ObservedOperation } from "../frontend/vault-api.ts";
import type { NativeVaultBuilders } from "./symmetry-adapter.ts";
import type { PublicVaultDefinition } from "./vault-definition-store.ts";
import { MAINNET_USDC } from "./native-defaults.ts";
import { RAYDIUM_ORACLE_KINDS, WSOL_MINT } from "./raydium-oracles.ts";
import { RAYDIUM_CLMM_PROGRAM, mainnetRaydiumPoolFor } from "./raydium-pools-mainnet.ts";

const rawAmountPattern = /^(0|[1-9][0-9]*)$/;
const CLMM_PRICE_SCALE = 1n << 128n;

const headers = { "Cache-Control": "no-store" };
const tokenPrograms = [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID];

type CreatedIndex = PublicVaultDefinition & { network: Network; vaultAddress: string; shareMint: string };
type PositionReader = (index: CreatedIndex, owner: string) => Promise<IndexSharePosition>;
export type VaultNavHolding = { mint: string; amountRaw: string };
export type NavVenueQuote = { mint: string; venue: "raydium" | "jupiter"; inMint: string; outMint: string; inAmountRaw: string; outAmountRaw: string };
export type StockNavQuotes = (holdings: readonly VaultNavHolding[]) => Promise<readonly NavVenueQuote[] | null>;

function formatMicroUsdc(micro: bigint): string {
  const whole = micro / 1_000_000n;
  const fraction = (micro % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

type NavCompositionAsset = {
  mint: { toBase58(): string };
  amount: { toString(): string };
  oracleAggregator?: {
    numOracles?: number;
    oracles?: {
      oracleSettings?: { oracleType?: number };
      accountsToLoadLutIds?: number[];
      accountsToLoadLutIndices?: number[];
    }[];
  };
};
type NavLut = { state?: { addresses?: { toBase58(): string }[] } };
type NavVault = { numTokens: number; composition: NavCompositionAsset[]; lutPubkeys?: readonly NavLut[] | null };

/** Composition identifies the slots. A live token-account balance replaces a stale zero accounted amount. */
export function holdingsWithVaultBalances(slots: readonly VaultNavHolding[], balances: ReadonlyMap<string, bigint> | null): VaultNavHolding[] {
  if (!balances) return [...slots];
  return slots.map(slot => ({ mint: slot.mint, amountRaw: (balances.get(slot.mint) ?? 0n).toString() }));
}

/** Accounted vault tokens. WSOL is support, not a stock mark; share mint is not backing. */
export function vaultNavHoldings(vault: NavVault, shareMint?: string): VaultNavHolding[] | null {
  if (!Number.isInteger(vault.numTokens) || vault.numTokens < 0 || vault.composition.length < vault.numTokens) return null;
  return vault.composition.slice(0, vault.numTokens)
    .map(asset => ({ mint: asset.mint.toBase58(), amountRaw: asset.amount.toString() }))
    .filter(holding => holding.mint !== WSOL_MINT && holding.mint !== shareMint);
}

/** Installed Raydium pool for a composition slot. Pyth/Hermes oracles are ignored, never queried. */
export function installedRaydiumPool(asset: NavCompositionAsset, luts?: readonly NavLut[] | null): { pool: string; kind: "raydium_clmm" | "raydium_cpmm" } | null {
  const oracles = asset.oracleAggregator?.oracles?.slice(0, asset.oracleAggregator.numOracles ?? 0) ?? [];
  for (const oracle of oracles) {
    const type = oracle.oracleSettings?.oracleType;
    const kind = type === RAYDIUM_ORACLE_KINDS.raydium_clmm ? "raydium_clmm" as const
      : type === RAYDIUM_ORACLE_KINDS.raydium_cpmm ? "raydium_cpmm" as const : null;
    if (!kind) continue;
    const lutId = oracle.accountsToLoadLutIds?.[0];
    const lutIndex = oracle.accountsToLoadLutIndices?.[0];
    const pool = lutId == null || lutIndex == null ? undefined : luts?.[lutId]?.state?.addresses?.[lutIndex]?.toBase58();
    if (pool) return { pool, kind };
  }
  return null;
}

/**
 * CLMM sqrt-price mark in USDC raw units. `(sqrt/2^64)^2` is raw mint1 per raw mint0, so decimals cancel.
 * A pool that is not a stock/USDC pair cannot be marked without a second price, so it stays unavailable.
 */
export function clmmSpotUsdcRaw(input: { mint0: string; mint1: string; sqrtPriceX64: string; stockMint: string; amountRaw: string }): string | null {
  if (!rawAmountPattern.test(input.sqrtPriceX64) || input.sqrtPriceX64 === "0" || !rawAmountPattern.test(input.amountRaw) || input.amountRaw === "0") return null;
  const squared = BigInt(input.sqrtPriceX64) ** 2n;
  const amount = BigInt(input.amountRaw);
  const stockIsBase = input.stockMint === input.mint0 && input.mint1 === MAINNET_USDC;
  const stockIsQuote = input.stockMint === input.mint1 && input.mint0 === MAINNET_USDC;
  if (!stockIsBase && !stockIsQuote) return null;
  const usdc = stockIsBase ? amount * squared / CLMM_PRICE_SCALE : amount * CLMM_PRICE_SCALE / squared;
  return usdc > 0n ? usdc.toString() : null;
}

export function raydiumNavQuote(holding: VaultNavHolding, spot: { mint0: string; mint1: string; sqrtPriceX64: string } | null): NavVenueQuote | null {
  if (!spot) return null;
  const outAmountRaw = clmmSpotUsdcRaw({ ...spot, stockMint: holding.mint, amountRaw: holding.amountRaw });
  if (!outAmountRaw) return null;
  return { mint: holding.mint, venue: "raydium", inMint: holding.mint, outMint: MAINNET_USDC, inAmountRaw: holding.amountRaw, outAmountRaw };
}

/** USDC in the vault plus marked stock tokens. Missing stock marks stay unavailable — never a share-count price. */
export function markedVaultNavUsdc(holdings: readonly VaultNavHolding[], quotes: readonly NavVenueQuote[] | null): string | null {
  if (!quotes) return null;
  try {
    let total = 0n;
    const quoted = new Map<string, NavVenueQuote>();
    for (const quote of quotes) {
      if (quoted.has(quote.mint) || (quote.venue !== "raydium" && quote.venue !== "jupiter")) return null;
      quoted.set(quote.mint, quote);
    }
    const seen = new Set<string>();
    for (const holding of holdings) {
      if (seen.has(holding.mint) || !rawAmountPattern.test(holding.amountRaw)) return null;
      seen.add(holding.mint);
      const amount = BigInt(holding.amountRaw);
      if (amount === 0n) continue;
      if (holding.mint === MAINNET_USDC) { total += amount; continue; }
      const quote = quoted.get(holding.mint);
      if (!quote || quote.inMint !== holding.mint || quote.outMint !== MAINNET_USDC) return null;
      if (!rawAmountPattern.test(quote.inAmountRaw) || !rawAmountPattern.test(quote.outAmountRaw)) return null;
      const quoteIn = BigInt(quote.inAmountRaw), quoteOut = BigInt(quote.outAmountRaw);
      if (quoteIn === 0n || quoteOut === 0n) return null;
      total += quoteOut * amount / quoteIn;
    }
    return total === 0n ? null : formatMicroUsdc(total);
  } catch {
    return null;
  }
}

function proRataVaultValue(sharesRaw: string, shareSupplyRaw: string | undefined, vaultValueUsdc: string): string | null {
  if (!/^(0|[1-9][0-9]*)$/.test(sharesRaw) || !shareSupplyRaw || !/^(0|[1-9][0-9]*)$/.test(shareSupplyRaw)) return null;
  const match = /^(0|[1-9][0-9]*)(?:\.([0-9]{1,6}))?$/.exec(vaultValueUsdc);
  if (!match) return null;
  const supply = BigInt(shareSupplyRaw);
  const vaultMicro = BigInt(match[1]) * 1_000_000n + BigInt((match[2] ?? "").padEnd(6, "0") || "0");
  if (supply === 0n || vaultMicro === 0n) return null;
  return formatMicroUsdc(BigInt(sharesRaw) * vaultMicro / supply);
}

export function attachPositionNav(position: IndexSharePosition, holdings: readonly VaultNavHolding[] | null, quotes: readonly NavVenueQuote[] | null): IndexSharePosition {
  if (!holdings || !rawAmountPattern.test(position.sharesRaw) || BigInt(position.sharesRaw) === 0n) return position;
  const vaultValueUsdc = markedVaultNavUsdc(holdings, quotes);
  if (!vaultValueUsdc) return position;
  const markedValueUsdc = proRataVaultValue(position.sharesRaw, position.shareSupplyRaw, vaultValueUsdc);
  return {
    ...position,
    vaultValueUsdc,
    ...(markedValueUsdc ? { markedValueUsdc, priceBasis: "pro-rata-vault-nav" } : {}),
  };
}

function documentedUsdcPool(mint: string): { pool: string; kind: "raydium_clmm" | "raydium_cpmm" } | null {
  const pool = mainnetRaydiumPoolFor(mint);
  if (!pool || pool.quoteMint !== MAINNET_USDC || (pool.kind !== "raydium_clmm" && pool.kind !== "raydium_cpmm")) return null;
  return { pool: pool.pool, kind: pool.kind };
}

function poolForHolding(vault: NavVault, holding: VaultNavHolding): { pool: string; kind: "raydium_clmm" | "raydium_cpmm" } | null {
  const asset = vault.composition.slice(0, vault.numTokens).find(entry => entry.mint.toBase58() === holding.mint);
  return (asset ? installedRaydiumPool(asset, vault.lutPubkeys) : null) ?? documentedUsdcPool(holding.mint);
}

type PoolAccountReader = { getAccountInfo(key: PublicKey, commitment?: "confirmed"): Promise<{ owner: { toBase58(): string }; data: Uint8Array } | null> };

async function quoteRaydiumClmm(connection: PoolAccountReader, pool: string, holding: VaultNavHolding): Promise<NavVenueQuote | null> {
  const account = await connection.getAccountInfo(new PublicKey(pool), "confirmed");
  if (!account || account.owner.toBase58() !== RAYDIUM_CLMM_PROGRAM) return null;
  const { RaydiumClmmPoolState } = await import("@symmetry-hq/sdk/dist/states/oracles/raydiumClmmOracle.js");
  const state = RaydiumClmmPoolState.decode(Buffer.from(account.data), 8);
  if (state.status !== 0 || state.liquidity.isZero()) return null;
  return raydiumNavQuote(holding, {
    mint0: state.tokenMint0.toBase58(), mint1: state.tokenMint1.toBase58(), sqrtPriceX64: state.sqrtPriceX64.toString(),
  });
}

async function quoteJupiter(holding: VaultNavHolding): Promise<NavVenueQuote | null> {
  const { jupiterMode } = await import("../runtime.ts");
  if (jupiterMode() !== "live") return null;
  const { priceFetch } = await import("./vault-prices.ts");
  const apiKey = process.env.JUPITER_API_KEY?.trim();
  const url = `https://api.jup.ag/swap/v1/quote?inputMint=${encodeURIComponent(holding.mint)}&outputMint=${MAINNET_USDC}&amount=${holding.amountRaw}&slippageBps=50`;
  const response = await priceFetch(url, {
    headers: apiKey ? { Accept: "application/json", "x-api-key": apiKey } : { Accept: "application/json" },
    cache: "no-store", signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) return null;
  const body = await response.json() as { inputMint?: string; outputMint?: string; inAmount?: string; outAmount?: string };
  if (body.inputMint !== holding.mint || body.outputMint !== MAINNET_USDC) return null;
  const quote: NavVenueQuote = {
    mint: holding.mint, venue: "jupiter", inMint: holding.mint, outMint: MAINNET_USDC,
    inAmountRaw: String(body.inAmount ?? ""), outAmountRaw: String(body.outAmount ?? ""),
  };
  if (!rawAmountPattern.test(quote.inAmountRaw) || !rawAmountPattern.test(quote.outAmountRaw) || quote.inAmountRaw === "0" || quote.outAmountRaw === "0") return null;
  return quote;
}

async function vaultTokenBalances(connection: Connection, owner: PublicKey): Promise<Map<string, bigint> | null> {
  try {
    const merged = new Map<string, bigint>();
    for (const program of tokenPrograms) {
      const accounts = await connection.getTokenAccountsByOwner(owner, { programId: program }, "confirmed");
      for (const entry of accounts.value) {
        if (!tokenPrograms.some(candidate => entry.account.owner.equals(candidate))) continue;
        const account = unpackAccount(entry.pubkey, entry.account, entry.account.owner);
        const mint = account.mint.toBase58();
        merged.set(mint, (merged.get(mint) ?? 0n) + account.amount);
      }
    }
    return merged;
  } catch {
    return null;
  }
}

/** Raydium CLMM spot first, Jupiter only when that pool mark is unavailable. Never Pyth, never the share count. */
async function liveStockQuotes(connection: PoolAccountReader, vault: NavVault, holdings: readonly VaultNavHolding[]): Promise<readonly NavVenueQuote[] | null> {
  const stocks = holdings.filter(holding => holding.mint !== MAINNET_USDC && rawAmountPattern.test(holding.amountRaw) && BigInt(holding.amountRaw) > 0n);
  if (!stocks.length) return [];
  const quotes: NavVenueQuote[] = [];
  for (const holding of stocks) {
    const pool = poolForHolding(vault, holding);
    const raydium = pool?.kind === "raydium_clmm" ? await quoteRaydiumClmm(connection, pool.pool, holding).catch(() => null) : null;
    const quote = raydium ?? await quoteJupiter(holding).catch(() => null);
    if (!quote) return null;
    quotes.push(quote);
  }
  return quotes;
}

function walletOwner(value: string | null): string {
  if (!value || value.length > 44) throw new Error("Wallet required");
  const key = new PublicKey(value);
  if (key.toBase58() !== value || !PublicKey.isOnCurve(key)) throw new Error("Wallet must be on curve");
  return value;
}

function createdIndex(index: PublicVaultDefinition): index is CreatedIndex {
  return (index.network === "mainnet-beta" || index.network === "devnet")
    && typeof index.vaultAddress === "string"
    && typeof index.shareMint === "string";
}

/** The native intent remains an active obligation even after an unfilled auction closes. */
export function nativeDepositAuctionState(intent: UIRebalanceIntent, now = Date.now()): "PENDING" | "FAILED" {
  const chain = intent.chain_data;
  if (chain.rebalanceType !== RebalanceType.Deposit || chain.currentAction !== RebalanceAction.Auction) return "PENDING";
  const auctions = Array.isArray(chain.auctions) ? chain.auctions : [];
  const tokens = Array.isArray(chain.tokens) ? chain.tokens : [];
  const ends = auctions.map(auction => Number(auction.endTime.toString())).filter(Number.isFinite);
  const auctionClosed = ends.length > 0 && Math.max(...ends) * 1000 <= now;
  const boughtAnyBasketLeg = tokens.some(token => token.mint.toBase58() !== MAINNET_USDC && token.mint.toBase58() !== WSOL_MINT && !token.amount.isZero());
  return auctionClosed && !boughtAnyBasketLeg ? "FAILED" : "PENDING";
}

/** A native intent is the only pending-operation source; a prepare response is never a receipt. */
export function pendingNativeOperation(intent: UIRebalanceIntent, vaultAddress: string, shareMint: string, owner: string, now = Date.now()): ObservedOperation | null {
  const chain = intent.chain_data;
  if (chain.vault.toBase58() !== vaultAddress || chain.owner.toBase58() !== owner) throw new Error("Native intent identity mismatch");
  if (chain.currentAction === RebalanceAction.NotActive) return null;
  const deposit = chain.rebalanceType === RebalanceType.Deposit;
  const withdrawal = chain.rebalanceType === RebalanceType.Withdraw;
  if (!deposit && !withdrawal) throw new Error("Native intent type is unavailable");
  const auctionState = nativeDepositAuctionState(intent, now);
  const phase = auctionState === "FAILED" ? "FAILED"
    : chain.currentAction === RebalanceAction.DepositTokens ? deposit ? "AWAITING_LOCK" : "REDEMPTION_CLAIM"
      : chain.currentAction === RebalanceAction.UpdatePrices ? "PRICING"
        : intent.mint_data ? "CLEANUP" : "AUCTION";
  const kind = deposit ? "deposit" : "withdraw";
  const blocker = auctionState === "FAILED"
    ? "This deposit did not buy the basket. Your USDC is still in Mag7 and is not shares."
    : deposit ? "Deposit pending settlement" : "Cash out pending settlement";
  return { operationId: `native-${kind}-${intent.formatted_data.pubkey}`, identity: { vaultAccount: vaultAddress, shareMint }, owner, kind, phase, nativeIntent: intent.formatted_data.pubkey, complete: false, blockers: [blocker] };
}

/** Kept as the deposit-specific seam for callers that must never label a withdrawal as a deposit. */
export function pendingNativeDeposit(intent: UIRebalanceIntent, vaultAddress: string, shareMint: string, owner: string): ObservedOperation | null {
  const operation = pendingNativeOperation(intent, vaultAddress, shareMint, owner);
  return operation?.kind === "deposit" ? operation : null;
}

/** A completed mint is the wallet's receipt. Symmetry can leave its prior intent account around
 * after dust cleanup, but this app has no native-intent resume API to safely expose as an action. */
export function pendingNativeOperationForPosition(intent: UIRebalanceIntent, vaultAddress: string, shareMint: string, owner: string, sharesRaw: string): ObservedOperation | null {
  if (BigInt(sharesRaw) > 0n) return null;
  return pendingNativeOperation(intent, vaultAddress, shareMint, owner);
}

async function pendingNativeOperations(native: NativeVaultBuilders, vaultAddress: string, shareMint: string, owner: string, sharesRaw: string): Promise<ObservedOperation[]> {
  const intentAddress = getRebalanceIntentPda(new PublicKey(vaultAddress), new PublicKey(owner)).toBase58();
  const account = await native.connection.getAccountInfo(new PublicKey(intentAddress), "confirmed");
  if (!account) return [];
  const { SYMMETRY_PROGRAM_ID } = await import("./symmetry-adapter.ts");
  if (!account.owner.equals(new PublicKey(SYMMETRY_PROGRAM_ID))) throw new Error("Native intent is unavailable");
  const pending = pendingNativeOperationForPosition(await native.sdk.fetchRebalanceIntent(intentAddress), vaultAddress, shareMint, owner, sharesRaw);
  return pending ? [pending] : [];
}

async function readerFor(network: Network): Promise<NativeVaultBuilders> {
  const { NativeVaultBuilders, readOnlyConnection } = await import("./symmetry-adapter.ts");
  const rpc = network === "mainnet-beta" ? getHeliusRpcUrl() : "https://api.devnet.solana.com";
  return new NativeVaultBuilders(readOnlyConnection(rpc), network);
}

/** Reads native SPL share accounts for a persisted vault definition. Definitions choose the vault
 * and mint; callers never provide an RPC, vault, mint, or network selector. */
export async function readPublishedIndexPosition(index: CreatedIndex, owner: string, native?: NativeVaultBuilders, quoteStocks?: StockNavQuotes): Promise<IndexSharePosition> {
  walletOwner(owner);
  const activeNative = native ?? await readerFor(index.network);
  if (activeNative.network !== index.network) throw new Error("Index network mismatch");
  const vaultKey = new PublicKey(index.vaultAddress);
  const mintKey = new PublicKey(index.shareMint);
  const { SYMMETRY_PROGRAM_ID } = await import("./symmetry-adapter.ts");
  await activeNative.assertNetwork();
  const vaultAccount = await activeNative.connection.getAccountInfo(vaultKey, "confirmed");
  if (!vaultAccount || !vaultAccount.owner.equals(new PublicKey(SYMMETRY_PROGRAM_ID))) throw new Error("Native vault is unavailable");
  const vault = await activeNative.sdk.fetchVault(index.vaultAddress);
  if (vault.ownAddress.toBase58() !== index.vaultAddress || vault.mint.toBase58() !== index.shareMint) throw new Error("Native vault identity mismatch");
  const mintAccount = await activeNative.connection.getAccountInfo(mintKey, "confirmed");
  if (!mintAccount || !tokenPrograms.some(program => mintAccount.owner.equals(program))) throw new Error("Share mint is unavailable");
  const mint = await getMint(activeNative.connection, mintKey, "confirmed", mintAccount.owner);
  const accounts = await activeNative.connection.getTokenAccountsByOwner(new PublicKey(owner), { mint: mintKey }, "confirmed");
  let shares = 0n;
  for (const entry of accounts.value) {
    if (!tokenPrograms.some(program => entry.account.owner.equals(program))) throw new Error("Share account has an unsupported token program");
    const account = unpackAccount(entry.pubkey, entry.account, entry.account.owner);
    if (!account.isInitialized || account.owner.toBase58() !== owner || account.mint.toBase58() !== index.shareMint) throw new Error("Share account identity mismatch");
    shares += account.amount;
  }
  const pendingOperations = await pendingNativeOperations(activeNative, index.vaultAddress, index.shareMint, owner, shares.toString());
  const position: IndexSharePosition = {
    indexId: index.indexId, indexName: index.name, owner, shareMint: index.shareMint,
    shareDecimals: mint.decimals, sharesRaw: shares.toString(), shareSupplyRaw: mint.supply.toString(),
    ...(pendingOperations.length ? { pendingOperations } : {}),
  };
  const slots = vaultNavHoldings(vault, index.shareMint);
  if (!slots || shares === 0n) return position;
  const balances = await vaultTokenBalances(activeNative.connection, vaultKey);
  const holdings = holdingsWithVaultBalances(slots, balances);
  let quotes: readonly NavVenueQuote[] | null = null;
  try { quotes = await (quoteStocks ?? (rows => liveStockQuotes(activeNative.connection, vault, rows)))(holdings); }
  catch { quotes = null; }
  return attachPositionNav(position, holdings, quotes);
}

/** Positive chain balances and locked native settlement intents are portfolio positions. A read
 * failure is not converted to zero, and a pending intent is not hidden as an empty portfolio. */
export async function readOwnedIndexPositions(owner: string, indexes: readonly PublicVaultDefinition[], readPosition?: PositionReader): Promise<IndexSharePosition[]> {
  walletOwner(owner);
  const reader = readPosition ?? readPublishedIndexPosition;
  const positions = await Promise.all(indexes.filter(createdIndex).map(index => reader(index, owner)));
  return positions.filter(position => BigInt(position.sharesRaw) > 0n || position.pendingOperations?.some(operation => !operation.complete));
}

function requestOwner(request: Request): string {
  const params = new URL(request.url).searchParams;
  if ([...params.keys()].some(key => key !== "wallet") || params.getAll("wallet").length !== 1) throw new Error("Unexpected query");
  return walletOwner(params.get("wallet"));
}

export async function handleIndexPosition(request: Request, indexId: string, dependencies: {
  getIndex: (indexId: string) => Promise<PublicVaultDefinition | null>;
  readPosition?: PositionReader;
}): Promise<Response> {
  let owner: string;
  try { owner = requestOwner(request); }
  catch { return Response.json({ error: "A valid connected Solana wallet is required." }, { status: 400, headers }); }
  try {
    const index = await dependencies.getIndex(indexId);
    if (!index || !createdIndex(index)) return Response.json({ error: "Index shares are unavailable." }, { status: 404, headers });
    return Response.json(await (dependencies.readPosition ?? readPublishedIndexPosition)(index, owner), { headers });
  } catch {
    return Response.json({ error: "Your position isn't available right now." }, { status: 503, headers });
  }
}

export async function handleIndexPositions(request: Request, dependencies: {
  listIndexes: () => Promise<PublicVaultDefinition[]>;
  readPosition?: PositionReader;
}): Promise<Response> {
  let owner: string;
  try { owner = requestOwner(request); }
  catch { return Response.json({ error: "A valid connected Solana wallet is required." }, { status: 400, headers }); }
  try {
    const positions = await readOwnedIndexPositions(owner, await dependencies.listIndexes(), dependencies.readPosition);
    return Response.json({ positions }, { headers });
  } catch {
    return Response.json({ error: "Your positions aren't available right now." }, { status: 503, headers });
  }
}
