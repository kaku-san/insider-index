import { Connection, PublicKey } from "@solana/web3.js";
import { navVaultConfig, navVaultServes, type NavVaultConfig } from "./config.ts";
import { NAV_VAULT_PROGRAM_ID, SHARE_DECIMALS, shareAta, tokenAmount } from "./program.ts";
import { prepareNavClaim, prepareNavDeposit, prepareNavWithdraw, readNavRequests, readNavVault, type NavConnection } from "./prepare.ts";

const HEADERS = { "Cache-Control": "no-store" };
const REQUEST_LIMIT = 4096;
export type NavDependencies = { config: (host?: string | null) => NavVaultConfig; connection: (config: NavVaultConfig) => NavConnection; now?: () => number };
const defaults: NavDependencies = {
  config: host => navVaultConfig(process.env, host),
  connection: config => new Connection(config.rpcUrl, { commitment: "confirmed" }),
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
  const config = deps.config(request?.headers.get("x-forwarded-host") ?? request?.headers.get("host"));
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
    return Response.json({
      indexId,
      kind: "nav-vault",
      phase: state.paused ? "PAUSED" : snapshot.pricesFresh ? "LIVE" : "PRICES_STALE",
      depositEnabled: snapshot.pricesFresh && !state.paused,
      ready: snapshot.pricesFresh && !state.paused,
      redeemEnabled: true,
      paused: state.paused,
      blockers: state.paused ? ["This vault is paused. Deposits are closed; cash out is in kind."] : snapshot.pricesFresh ? [] : ["Vault prices are stale. Deposits reopen when the keeper refreshes them. Cash out still works."],
      identity: { network: config.network, programId: config.programId.toBase58(), vaultAccount: state.address.toBase58(), shareMint: state.shareMint.toBase58(), shareDecimals: SHARE_DECIMALS, usdcMint: state.usdcMint.toBase58(), indexId, kind: "nav-vault" },
      shareSupplyRaw: snapshot.supply.toString(),
      sharePrice: snapshot.supply > 0n ? micro(snapshot.nav * 1_000_000n / snapshot.supply) : null,
      sharePriceBasis: "NAV vault: USDC buffer + keeper-posted stock marks",
      hostEntryFeeBps: state.entryFeeBps,
      hostExitFeeBps: 0,
      targetWeights: state.legs.map(leg => ({ mint: leg.mint.toBase58(), weightBps: leg.weightBps })),
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

export async function handleNavClaimPrepare(request: Request, indexId: string, deps: NavDependencies = defaults): Promise<Response> {
  try {
    const body = await readBody(request);
    if (typeof body.owner !== "string" || typeof body.request !== "string") throw new Error("Wallet owner and request are required.");
    const { config, connection } = served(indexId, deps, request);
    return Response.json(await prepareNavClaim({ connection, network: config.network, indexId, owner: body.owner, request: body.request, programId: config.programId }), { headers: HEADERS });
  } catch (error) { return plain(error, (error as { status?: number }).status ?? 400); }
}

export { NAV_VAULT_PROGRAM_ID };
