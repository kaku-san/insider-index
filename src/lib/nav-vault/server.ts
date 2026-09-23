import { Connection, PublicKey } from "@solana/web3.js";
import { navVaultConfig, navVaultServes, type NavVaultConfig } from "./config.ts";
import { NAV_VAULT_PROGRAM_ID, SHARE_DECIMALS, ata, tokenAmount } from "./program.ts";
import { prepareNavDeposit, prepareNavWithdraw, readNavVault, type NavConnection } from "./prepare.ts";

const HEADERS = { "Cache-Control": "no-store" };
const REQUEST_LIMIT = 4096;
export type NavDependencies = { config: () => NavVaultConfig; connection: (config: NavVaultConfig) => NavConnection; now?: () => number };
const defaults: NavDependencies = {
  config: () => navVaultConfig(),
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

function served(indexId: string, deps: NavDependencies) {
  const config = deps.config();
  if (!navVaultServes(indexId, config)) throw Object.assign(new Error("This index is not on the NAV vault."), { status: 404 });
  return { config, connection: deps.connection(config) };
}

/** VaultReadiness shape consumed by VaultFlow. Deposits need a fresh mark; exits are always open. */
export async function handleNavReadiness(indexId: string, deps: NavDependencies = defaults): Promise<Response> {
  try {
    const { config, connection } = served(indexId, deps);
    const snapshot = await readNavVault(connection, indexId, config.programId, deps.now?.());
    if (!snapshot) return plain(new Error("This index does not have a NAV vault yet."), 404);
    const { state } = snapshot;
    return Response.json({
      indexId,
      kind: "nav-vault",
      phase: snapshot.pricesFresh ? "LIVE" : "PRICES_STALE",
      depositEnabled: snapshot.pricesFresh,
      ready: snapshot.pricesFresh,
      redeemEnabled: true,
      blockers: snapshot.pricesFresh ? [] : ["Vault prices are stale. Deposits reopen when the keeper refreshes them. Cash out still works."],
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
    const { config, connection } = served(indexId, deps);
    const snapshot = await readNavVault(connection, indexId, config.programId, deps.now?.());
    if (!snapshot) return plain(new Error("This index does not have a NAV vault yet."), 404);
    const shares = tokenAmount((await connection.getAccountInfo(ata(owner, snapshot.state.shareMint), "confirmed"))?.data);
    return Response.json({
      indexId, owner: owner.toBase58(), shareMint: snapshot.state.shareMint.toBase58(), shareDecimals: SHARE_DECIMALS,
      sharesRaw: shares.toString(), shareSupplyRaw: snapshot.supply.toString(), vaultValueUsdc: micro(snapshot.nav),
      markedAt: snapshot.state.pricesUpdatedAt > 0 ? new Date(snapshot.state.pricesUpdatedAt * 1000).toISOString() : null,
      priceBasis: "NAV vault: USDC buffer + keeper-posted stock marks (cash may be pending investment)",
      pendingOperations: [],
    }, { headers: HEADERS });
  } catch (error) { return plain(error, (error as { status?: number }).status ?? 400); }
}

export async function handleNavDepositPrepare(request: Request, indexId: string, deps: NavDependencies = defaults): Promise<Response> {
  try {
    const body = await readBody(request);
    if (typeof body.owner !== "string" || typeof body.amountRaw !== "string") throw new Error("Wallet owner and amountRaw are required.");
    const { config, connection } = served(indexId, deps);
    const step = await prepareNavDeposit({ connection, network: config.network, indexId, owner: body.owner, amountRaw: body.amountRaw, programId: config.programId, nowSeconds: deps.now?.() });
    return Response.json(step, { headers: HEADERS });
  } catch (error) { return plain(error, (error as { status?: number }).status ?? 400); }
}

export async function handleNavWithdrawPrepare(request: Request, indexId: string, deps: NavDependencies = defaults): Promise<Response> {
  try {
    const body = await readBody(request);
    if (typeof body.owner !== "string" || typeof body.shareAmountRaw !== "string") throw new Error("Wallet owner and shareAmountRaw are required.");
    const { config, connection } = served(indexId, deps);
    const step = await prepareNavWithdraw({ connection, network: config.network, indexId, owner: body.owner, shareAmountRaw: body.shareAmountRaw, programId: config.programId, nowSeconds: deps.now?.() });
    return Response.json(step, { headers: HEADERS });
  } catch (error) { return plain(error, (error as { status?: number }).status ?? 400); }
}

export { NAV_VAULT_PROGRAM_ID };
