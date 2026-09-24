import { Connection, PublicKey } from "@solana/web3.js";
import { navVaultConfig, navVaultServes, type NavVaultConfig } from "./config.ts";
import { NAV_VAULT_PROGRAM_ID, SHARE_DECIMALS, decodeVault, shareAta, tokenAmount, vaultPda, type NavRequest } from "./program.ts";
import { indexDisplayName, publishedSliceFor, sliceDisplayName, type TradableSlice } from "./slices.ts";
import { navHeldSlice } from "./held.ts";
import { mapLimit, memo } from "../cache.ts";
import { createServiceSupabase } from "../supabase.ts";
import { prepareNavClaim, prepareNavDeposit, prepareNavWithdraw, readNavRequests, readNavVault, type NavConnection } from "./prepare.ts";

const HEADERS = { "Cache-Control": "no-store" };
const REQUEST_LIMIT = 4096;
/** Vaults read at once for the wallet positions list (each read is ~3 RPC calls). */
const POSITIONS_CONCURRENCY = 4;
export type NavDependencies = { config: () => NavVaultConfig; connection: (config: NavVaultConfig) => NavConnection; now?: () => number; slice?: (indexId: string, vaultMints: readonly string[]) => Promise<TradableSlice | null> };
/** Published slice table (service role) with the committed JSON as fallback; memoised so readiness polls stay cheap. */
function defaultSlice(indexId: string, vaultMints: readonly string[]): Promise<TradableSlice | null> {
  const mintSet = new Set(vaultMints);
  const matchesVault = (slice: TradableSlice) => slice.vaultLegs.length === mintSet.size && slice.vaultLegs.every(leg => mintSet.has(leg.mint));
  return memo(`nav_vault_slice:${indexId}:${[...mintSet].sort().join(",")}`, { ttlMs: 5 * 60_000 }, () => {
    const db = createServiceSupabase();
    return publishedSliceFor(indexId, db ? (fn, args) => Promise.resolve(db.rpc(fn, args)) : null, matchesVault);
  });
}
const defaults: NavDependencies = {
  config: () => navVaultConfig(process.env),
  connection: config => new Connection(config.rpcUrl, { commitment: "confirmed" }),
  slice: defaultSlice,
};

const UNAVAILABLE = "The NAV vault is unavailable.";
/** RPC/transport failures and raw library text never reach the user; product messages pass through. */
export function plainMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : "";
  if (!text) return UNAVAILABLE;
  if (/Invalid public key input|Non-base58 character/i.test(text)) return "A valid connected Solana wallet is required.";
  if (/\b429\b|Too Many Requests|failed to get|fetch failed|ECONN|ETIMEDOUT|socket hang up/i.test(text)) return UNAVAILABLE;
  return text;
}
function plain(error: unknown, status = 400) {
  return Response.json({ error: plainMessage(error) }, { status, headers: HEADERS });
}

function micro(raw: bigint) {
  const whole = raw / 1_000_000n, fraction = (raw % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (text.length > REQUEST_LIMIT) throw new Error("Request is too large.");
  const body = JSON.parse(text || "null");
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("A request body is required.");
  return body as Record<string, unknown>;
}

function served(indexId: string, deps: NavDependencies, request?: Request) {
  void request;
  const config = deps.config();
  if (!navVaultServes(indexId, config)) throw Object.assign(new Error("This index is not on the NAV vault."), { status: 404 });
  return { config, connection: deps.connection(config) };
}

/** VaultReadiness shape consumed by VaultFlow. Deposits need a fresh mark; exits are always open. */
export async function handleNavReadiness(indexId: string, deps: NavDependencies = defaults, request?: Request): Promise<Response> {
  try {
    const { config, connection } = served(indexId, deps, request);
    const snapshot = await readNavVault(connection, indexId, config.programId, deps.now?.());
    if (!snapshot) return plain(new Error("This index does not have a NAV vault yet."), 404);
    const { state } = snapshot;
    const slice = await (deps.slice ?? defaultSlice)(indexId, state.legs.map(leg => leg.mint.toBase58()));
    return Response.json({
      indexId,
      kind: "nav-vault",
      phase: state.paused ? "PAUSED" : snapshot.pricesFresh ? "LIVE" : "PRICES_STALE",
      // Stale marks do not hide Invest: the client waits for the keeper's next post and re-prepares.
      depositEnabled: !state.paused,
      ready: !state.paused,
      redeemEnabled: true,
      paused: state.paused,
      blockers: state.paused ? ["This vault is paused. Deposits are closed; cash out is in kind."] : [],
      identity: { network: config.network, programId: config.programId.toBase58(), vaultAccount: state.address.toBase58(), shareMint: state.shareMint.toBase58(), shareDecimals: SHARE_DECIMALS, usdcMint: state.usdcMint.toBase58(), indexId, kind: "nav-vault" },
      shareSupplyRaw: snapshot.supply.toString(),
      sharePrice: snapshot.supply > 0n ? micro(snapshot.nav * 1_000_000n / snapshot.supply) : null,
      sharePriceBasis: "NAV vault: USDC buffer + keeper-posted stock marks",
      hostEntryFeeBps: state.entryFeeBps,
      hostExitFeeBps: 0,
      targetWeights: state.legs.map(leg => ({ mint: leg.mint.toBase58(), weightBps: leg.weightBps })),
      // The vault holds the TRADABLE slice of the disclosed book (on-chain legs are authoritative).
      slice: (() => {
        const tradableLegs = state.legs.length;
        // Only describe the slice when it IS the on-chain leg set (same mints); never invent totals.
        const matches = slice && slice.vaultLegs.length === tradableLegs && slice.vaultLegs.every(leg => state.legs.some(onChain => onChain.mint.toBase58() === leg.mint));
        if (!slice || !matches) return { tradableLegs, totalLegs: null, disclosedWeightBps: null, excluded: [] };
        // Held names carry the on-chain target weight; excluded names carry disclosed weight + scan reason.
        const vaultLegs = slice.vaultLegs.map(leg => ({ ticker: leg.ticker, mint: leg.mint, disclosedWeightBps: leg.disclosedWeightBps, targetWeightBps: state.legs.find(onChain => onChain.mint.toBase58() === leg.mint)?.weightBps ?? leg.targetWeightBps }));
        return { tradableLegs, totalLegs: slice.totalLegs, disclosedWeightBps: slice.disclosedWeightBps, vaultLegs, excluded: slice.excluded.map(item => ({ ticker: item.ticker, mint: item.mint, disclosedWeightBps: item.disclosedWeightBps, reason: item.reason })) };
      })(),
      navVault: { navUsdc: micro(snapshot.nav), usdcBufferUsdc: micro(snapshot.usdcBalance), bufferBps: state.bufferBps, priceAgeSecs: snapshot.priceAgeSecs },
    }, { headers: HEADERS });
  } catch (error) { return plain(error, (error as { status?: number }).status ?? 503); }
}

/** One wallet's NAV position payload. `requests` lets the list read every open request once instead of per vault. */
async function navPositionPayload(owner: PublicKey, indexId: string, config: NavVaultConfig, connection: NavConnection, deps: NavDependencies, requests?: NavRequest[]) {
  const snapshot = await readNavVault(connection, indexId, config.programId, deps.now?.());
  if (!snapshot) return null;
  const { state } = snapshot;
  const [shareAccount, openRequests] = await Promise.all([
    connection.getAccountInfo(shareAta(owner, state.shareMint), "confirmed"),
    requests ? Promise.resolve(requests.filter(request => request.vault.equals(state.address))) : readNavRequests(connection, state.address, owner, config.programId),
  ]);
  const shares = tokenAmount(shareAccount?.data);
  const now = deps.now?.() ?? Math.floor(Date.now() / 1000);
  // Open exit requests are observed operations: VaultFlow shows "cash out settling" until they close.
  const pendingOperations = openRequests.map(request => ({
    operationId: request.address.toBase58(), owner: owner.toBase58(), kind: "withdraw", complete: false,
    phase: now >= request.claimableAt ? "CLAIMABLE_IN_KIND" : "CONVERTING",
    confirmedSharesBurnedRaw: request.shares.toString(),
    nextAction: now >= request.claimableAt ? "Claim your share of the vault in kind." : "The keeper is converting your share of the vault to USDC.",
    blockers: [],
  }));
  const markedAt = state.pricesUpdatedAt > 0 ? new Date(state.pricesUpdatedAt * 1000).toISOString() : null;
  // Tickers label the on-chain legs; balances and marks come only from the chain read above.
  const mints = state.legs.map(leg => leg.mint.toBase58());
  const slice = shares > 0n ? await (deps.slice ?? defaultSlice)(indexId, mints).catch(() => null) : null;
  const held = navHeldSlice({
    shares, supply: snapshot.supply, usdcBalance: snapshot.usdcBalance, reservedUsdc: state.reservedUsdc, markedAt, pricesFresh: snapshot.pricesFresh,
    legs: state.legs.map((leg, i) => ({ ticker: slice?.vaultLegs.find(row => row.mint === mints[i])?.ticker ?? `${mints[i]!.slice(0, 4)}…${mints[i]!.slice(-4)}`, mint: mints[i]!, decimals: leg.decimals, price: leg.price, reserved: leg.reserved, balance: snapshot.legBalances[i] ?? 0n })),
  });
  return {
    indexId, indexName: sliceDisplayName(indexId) ?? undefined, owner: owner.toBase58(), shareMint: state.shareMint.toBase58(), shareDecimals: SHARE_DECIMALS,
    sharesRaw: shares.toString(), shareSupplyRaw: snapshot.supply.toString(), vaultValueUsdc: micro(snapshot.nav),
    markedAt,
    priceBasis: "NAV vault: USDC buffer + keeper-posted stock marks (cash may be pending investment)",
    pendingOperations,
    ...(held ? { held } : {}),
  };
}

export async function handleNavPosition(request: Request, indexId: string, deps: NavDependencies = defaults): Promise<Response> {
  try {
    const wallet = new URL(request.url).searchParams.get("wallet") ?? "";
    const owner = new PublicKey(wallet);
    const { config, connection } = served(indexId, deps, request);
    const position = await navPositionPayload(owner, indexId, config, connection, deps);
    if (!position) return plain(new Error("This index does not have a NAV vault yet."), 404);
    return Response.json(position, { headers: HEADERS });
  } catch (error) { return plain(error, (error as { status?: number }).status ?? 400); }
}

export async function handleNavDepositPrepare(request: Request, indexId: string, deps: NavDependencies = defaults): Promise<Response> {
  try {
    const body = await readBody(request);
    if (typeof body.owner !== "string" || typeof body.amountRaw !== "string") throw new Error("Wallet owner and amountRaw are required.");
    const { config, connection } = served(indexId, deps, request);
    const step = await prepareNavDeposit({ connection, network: config.network, indexId, owner: body.owner, amountRaw: body.amountRaw, programId: config.programId, nowSeconds: deps.now?.() });
    return Response.json(step, { headers: HEADERS });
  } catch (error) { return plain(error, (error as { status?: number }).status ?? 400); }
}

export async function handleNavWithdrawPrepare(request: Request, indexId: string, deps: NavDependencies = defaults): Promise<Response> {
  try {
    const body = await readBody(request);
    if (typeof body.owner !== "string" || typeof body.shareAmountRaw !== "string") throw new Error("Wallet owner and shareAmountRaw are required.");
    const { config, connection } = served(indexId, deps, request);
    const step = await prepareNavWithdraw({ connection, network: config.network, indexId, owner: body.owner, shareAmountRaw: body.shareAmountRaw, inKind: body.requestedExitMode === "in-kind", programId: config.programId, nowSeconds: deps.now?.() });
    return Response.json(step, { headers: HEADERS });
  } catch (error) { return plain(error, (error as { status?: number }).status ?? 400); }
}

/** All NAV positions for a wallet across the DB's public indexes (one vault read per index with a NAV vault). */
export async function handleNavPositions(request: Request, dependencies: { listIndexes: () => Promise<{ indexId: string; name?: string | null }[]> }, deps: NavDependencies = defaults): Promise<Response> {
  let owner: PublicKey;
  try { owner = new PublicKey(new URL(request.url).searchParams.get("wallet") ?? ""); }
  catch { return plain(new Error("A valid connected Solana wallet is required."), 400); }
  try {
    const config = deps.config();
    if (!config.enabled) return Response.json({ positions: [] }, { headers: HEADERS });
    const connection = deps.connection(config);
    const indexes = (await dependencies.listIndexes()).filter(index => navVaultServes(index.indexId, config));
    // One vault-existence read, one owner-scoped request scan, then the vaults in parallel: a
    // sequential per-vault fan-out (each with its own program scan) took 6-17 s on mainnet and made
    // the Positions screen lag well behind a confirmed deposit.
    const [vaults, requests] = await Promise.all([
      connection.getMultipleAccountsInfo(indexes.map(index => vaultPda(index.indexId, config.programId)), "confirmed"),
      indexes.length ? readNavRequests(connection, null, owner, config.programId) : Promise.resolve([]),
    ]);
    const live = indexes.filter((_, i) => Boolean(vaults[i]));
    const read = await mapLimit(live, POSITIONS_CONCURRENCY, async index => {
      const position = await navPositionPayload(owner, index.indexId, config, connection, deps, requests);
      if (!position) throw new Error("position read failed");
      return { ...position, indexName: indexDisplayName(index.name) ?? position.indexName ?? index.indexId };
    });
    const positions = read.filter(position => position.sharesRaw !== "0" || position.pendingOperations.length);
    return Response.json({ positions }, { headers: HEADERS });
  } catch { return plain(new Error("Your positions aren't available right now."), 503); }
}

/** Which of these index ids have a NAV vault on chain (drives Live status on Discover). */
export async function handleNavVaultList(request: Request, deps: NavDependencies = defaults): Promise<Response> {
  try {
    const ids = (new URL(request.url).searchParams.get("ids") ?? "").split(",").map(id => id.trim()).filter(id => /^[A-Za-z0-9_-]{1,64}$/.test(id)).slice(0, 100);
    const config = deps.config();
    if (!config.enabled || !ids.length) return Response.json({ indexes: [] }, { headers: HEADERS });
    const served = ids.filter(id => navVaultServes(id, config));
    const infos = await deps.connection(config).getMultipleAccountsInfo(served.map(id => vaultPda(id, config.programId)), "confirmed");
    const indexes = served.flatMap((indexId, i) => {
      const info = infos[i];
      if (!info) return [];
      const state = decodeVault(vaultPda(indexId, config.programId), info.data);
      return [{ indexId, network: config.network, vault: state.address.toBase58(), shareMint: state.shareMint.toBase58(), paused: state.paused }];
    });
    return Response.json({ indexes }, { headers: { "Cache-Control": "public, max-age=30" } });
  } catch (error) { return plain(error, 503); }
}

export async function handleNavClaimPrepare(request: Request, indexId: string, deps: NavDependencies = defaults): Promise<Response> {
  try {
    const body = await readBody(request);
    if (typeof body.owner !== "string" || typeof body.request !== "string") throw new Error("Wallet owner and request are required.");
    const { config, connection } = served(indexId, deps, request);
    return Response.json(await prepareNavClaim({ connection, network: config.network, indexId, owner: body.owner, request: body.request, programId: config.programId }), { headers: HEADERS });
  } catch (error) { return plain(error, (error as { status?: number }).status ?? 400); }
}

export { NAV_VAULT_PROGRAM_ID };
