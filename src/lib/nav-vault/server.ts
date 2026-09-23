import { Connection, PublicKey } from "@solana/web3.js";
import { navVaultConfig, navVaultServes, type NavVaultConfig } from "./config.ts";
import { NAV_VAULT_PROGRAM_ID, SHARE_DECIMALS, decodeVault, shareAta, tokenAmount, vaultPda } from "./program.ts";
import { publishedSliceFor, type TradableSlice } from "./slices.ts";
import { memo } from "../cache.ts";
import { createServiceSupabase } from "../supabase.ts";
import { prepareNavClaim, prepareNavDeposit, prepareNavWithdraw, readNavRequests, readNavVault, type NavConnection } from "./prepare.ts";

const HEADERS = { "Cache-Control": "no-store" };
const REQUEST_LIMIT = 4096;
export type NavDependencies = { config: () => NavVaultConfig; connection: (config: NavVaultConfig) => NavConnection; now?: () => number; slice?: (indexId: string) => Promise<TradableSlice | null> };
/** Published slice table (service role) with the committed JSON as fallback; memoised so readiness polls stay cheap. */
function defaultSlice(indexId: string): Promise<TradableSlice | null> {
  return memo(`nav_vault_slice:${indexId}`, { ttlMs: 5 * 60_000 }, () => {
    const db = createServiceSupabase();
    return publishedSliceFor(indexId, db ? (fn, args) => Promise.resolve(db.rpc(fn, args)) : null);
  });
}
const defaults: NavDependencies = {
  config: () => navVaultConfig(process.env),
  connection: config => new Connection(config.rpcUrl, { commitment: "confirmed" }),
  slice: defaultSlice,
};

function plain(error: unknown, status = 400) {
  return Response.json({ error: error instanceof Error ? error.message : "The NAV vault is unavailable." }, { status, headers: HEADERS });
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
    const slice = await (deps.slice ?? defaultSlice)(indexId);
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

export async function handleNavPosition(request: Request, indexId: string, deps: NavDependencies = defaults): Promise<Response> {
  try {
    const wallet = new URL(request.url).searchParams.get("wallet") ?? "";
    const owner = new PublicKey(wallet);
    const { config, connection } = served(indexId, deps, request);
    const snapshot = await readNavVault(connection, indexId, config.programId, deps.now?.());
    if (!snapshot) return plain(new Error("This index does not have a NAV vault yet."), 404);
    const shares = tokenAmount((await connection.getAccountInfo(shareAta(owner, snapshot.state.shareMint), "confirmed"))?.data);
    const now = deps.now?.() ?? Math.floor(Date.now() / 1000);
    // Open exit requests are observed operations: VaultFlow shows "cash out settling" until they close.
    const pendingOperations = (await readNavRequests(connection, snapshot.state.address, owner, config.programId)).map(request => ({
      operationId: request.address.toBase58(), owner: owner.toBase58(), kind: "withdraw", complete: false,
      phase: now >= request.claimableAt ? "CLAIMABLE_IN_KIND" : "CONVERTING",
      confirmedSharesBurnedRaw: request.shares.toString(),
      nextAction: now >= request.claimableAt ? "Claim your share of the vault in kind." : "The keeper is converting your share of the vault to USDC.",
      blockers: [],
    }));
    return Response.json({
      indexId, owner: owner.toBase58(), shareMint: snapshot.state.shareMint.toBase58(), shareDecimals: SHARE_DECIMALS,
      sharesRaw: shares.toString(), shareSupplyRaw: snapshot.supply.toString(), vaultValueUsdc: micro(snapshot.nav),
      markedAt: snapshot.state.pricesUpdatedAt > 0 ? new Date(snapshot.state.pricesUpdatedAt * 1000).toISOString() : null,
      priceBasis: "NAV vault: USDC buffer + keeper-posted stock marks (cash may be pending investment)",
      pendingOperations,
    }, { headers: HEADERS });
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
    const vaults = await connection.getMultipleAccountsInfo(indexes.map(index => vaultPda(index.indexId, config.programId)), "confirmed");
    const positions = [];
    for (const [i, index] of indexes.entries()) {
      if (!vaults[i]) continue;
      const response = await handleNavPosition(new Request(`http://local/?wallet=${owner.toBase58()}`), index.indexId, deps);
      if (!response.ok) throw new Error("position read failed");
      const position = await response.json() as { sharesRaw: string; pendingOperations: unknown[] };
      if (position.sharesRaw !== "0" || position.pendingOperations.length) positions.push({ ...position, indexName: index.name ?? index.indexId });
    }
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
