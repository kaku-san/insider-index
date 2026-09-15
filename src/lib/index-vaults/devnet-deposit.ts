import { randomUUID } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { address, rawAmount, sdkRawAmount } from "./amounts.ts";
import { NativeVaultBuilders, readOnlyConnection, SYMMETRY_PROGRAM_ID } from "./symmetry-adapter.ts";
import type { VaultIdentity } from "./adapter-contract.ts";
import { feeSnapshot } from "./fees.ts";
import { DEVNET_DEPOSIT_BLOCKERS, DEVNET_TEST_VAULT } from "./devnet-contract.ts";
import type { DevnetDepositPreview, DevnetDepositRequest } from "./devnet-contract.ts";

const deployer = "C7ye6UvJ7jirwCmt3fKmt55MvcW9yBVpgqzZzgCWYQyB";
// Observation identity only. This is not registration/publication or entry authorization.
export const devnetTestIdentity: VaultIdentity = {
  ...DEVNET_TEST_VAULT, programId: SYMMETRY_PROGRAM_ID,
  hostTreasury: deployer, initialDeployer: deployer, indexId: "execution-test-stocklana-devnet",
  deploymentGeneration: 1, metadataHash: "unverified:empty-native-uri",
};

export function parseDevnetDepositRequest(body: unknown): DevnetDepositRequest {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Deposit request required");
  const input = body as Record<string, unknown>;
  if (Object.keys(input).some(key => !["network", "vaultAccount", "shareMint", "amountUsdcRaw", "owner", "expectedStateHash"].includes(key))) throw new Error("Unexpected deposit field");
  if (input.network !== "devnet" || input.vaultAccount !== DEVNET_TEST_VAULT.vaultAccount || input.shareMint !== DEVNET_TEST_VAULT.shareMint) throw new Error("Only the existing devnet test vault is supported");
  if (typeof input.amountUsdcRaw !== "string" || input.amountUsdcRaw.length > 16) throw new Error("Raw USDC amount required");
  rawAmount(input.amountUsdcRaw, true); sdkRawAmount(input.amountUsdcRaw);
  if (input.owner !== null) {
    if (typeof input.owner !== "string") throw new Error("Owner must be a Solana public key or null");
    address(input.owner);
    if (!PublicKey.isOnCurve(new PublicKey(input.owner))) throw new Error("Wallet owner must be on curve");
  }
  if (input.expectedStateHash !== undefined && (typeof input.expectedStateHash !== "string" || !/^[a-f0-9]{64}$/.test(input.expectedStateHash))) throw new Error("Invalid state hash");
  return input as unknown as DevnetDepositRequest;
}

/** Read-only transport, fixed public devnet endpoint; never inherits the single-trade mainnet RPC. */
export function devnetNativeReader() {
  return new NativeVaultBuilders(readOnlyConnection("https://api.devnet.solana.com"), "devnet");
}
export async function previewDevnetDeposit(input: DevnetDepositRequest, native = devnetNativeReader()): Promise<DevnetDepositPreview> {
  parseDevnetDepositRequest(input);
  if (native.network !== "devnet") throw new Error("Devnet reader required");
  const { vault, mint, stateHash } = await native.read(devnetTestIdentity); // includes genesis and exact identity checks
  const global = await native.sdk.fetchGlobalConfig();
  const fees = feeSnapshot(vault, global);
  const position = input.owner ? await native.position(devnetTestIdentity, input.owner) : null;
  const intent = input.owner ? await native.ownerIntent(devnetTestIdentity, input.owner) : null;
  const blockers: string[] = [...DEVNET_DEPOSIT_BLOCKERS];
  if (input.expectedStateHash && input.expectedStateHash !== stateHash) blockers.unshift("Vault state changed. Preview again.");
  if (!vault.settings.depositsAreAllowed || !global.allowInteractions) blockers.push("Native deposits or protocol interactions are disabled.");
  if (!fees.stocklanaFeesValid) blockers.push("Native fee configuration differs from the approved host fee policy.");
  if (intent) blockers.unshift("Existing native intent: recovery is required; do not create another deposit.");
  if (!input.owner) blockers.push("Connect a live Solana wallet to inspect its native share balance and pending intent.");
  return {
    identity: DEVNET_TEST_VAULT, owner: input.owner, amountUsdcRaw: input.amountUsdcRaw,
    observedAt: new Date().toISOString(), observedSlot: await native.connection.getSlot("confirmed"), stateHash,
    shareSupplyRaw: mint.supply.toString(), shareBalanceRaw: position?.shareBalanceRaw ?? null,
    nativeIntent: intent?.chain_data.ownAddress?.toBase58() ?? null,
    holdings: vault.composition.slice(0, vault.numTokens).map(asset => ({ mint: asset.mint.toBase58(), amountRaw: asset.amount.toString(), weightBps: asset.weight, active: asset.active === 1 })),
    hostEntryFeeBps: fees.hostEntryFeeBps, hostExitFeeBps: fees.hostExitFeeBps, estimatedSharesRaw: null,
    prepared: {
      operationId: randomUUID(), phase: "BLOCKED", requires: "wait", transactions: [], configHash: stateHash,
      blockers, constraints: [
        { label: "Native shares", value: "Unavailable until native accounting and settlement are verified", strength: "unverified" },
        { label: "Fees", value: "Host fees only; protocol, network, rent, bounty and swap costs are separate and unquoted", strength: "app-policy" },
        { label: "Exit", value: "Underlying tokens first; no guaranteed USDC redemption", strength: "unverified" },
      ],
    },
  };
}

const headers = { "Cache-Control": "no-store" };
const PREVIEW_TIMEOUT_MS = 8_000;
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("Devnet preview timed out")), timeoutMs);
  });
  try { return await Promise.race([promise, timeout]); }
  finally { if (timer) clearTimeout(timer); }
}
/** Both preview and prepare are observations. No auth/session or broadcast surface is enabled. */
export async function handleDevnetDeposit(request: Request, prepare: boolean, native?: NativeVaultBuilders, timeoutMs = PREVIEW_TIMEOUT_MS): Promise<Response> {
  let input: DevnetDepositRequest;
  try {
    const text = await request.text();
    if (text.length > 2048) return Response.json({ error: "Request too large" }, { status: 413, headers });
    input = parseDevnetDepositRequest(JSON.parse(text));
    if (prepare && (!input.owner || !input.expectedStateHash)) throw new Error("Preview with a live wallet before preparing a deposit");
  } catch { return Response.json({ error: "Invalid devnet deposit request" }, { status: 400, headers }); }
  try {
    const preview = await withTimeout(previewDevnetDeposit(input, native), timeoutMs);
    return Response.json(preview, { status: prepare ? 503 : 200, headers });
  } catch {
    // Do not leak RPC/configuration errors or mistake unavailability for an empty balance.
    return Response.json({ error: "Devnet vault observation unavailable. Deposits and signing remain disabled." }, { status: 503, headers });
  }
}
