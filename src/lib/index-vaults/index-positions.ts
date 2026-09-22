import { PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getMint, unpackAccount } from "@solana/spl-token";
import { getRebalanceIntentPda } from "@symmetry-hq/sdk/dist/instructions/pda.js";
import { RebalanceAction, RebalanceType, type UIRebalanceIntent } from "@symmetry-hq/sdk/dist/layouts/intents/rebalanceIntent.js";
import { getHeliusRpcUrl } from "../helius.ts";
import type { IndexSharePosition, Network, ObservedOperation } from "../frontend/vault-api.ts";
import type { NativeVaultBuilders } from "./symmetry-adapter.ts";
import type { PublicVaultDefinition } from "./vault-definition-store.ts";

const headers = { "Cache-Control": "no-store" };
const tokenPrograms = [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID];

type CreatedIndex = PublicVaultDefinition & { network: Network; vaultAddress: string; shareMint: string };
type PositionReader = (index: CreatedIndex, owner: string) => Promise<IndexSharePosition>;

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

/** A native intent is the only pending-operation source; a prepare response is never a receipt. */
export function pendingNativeOperation(intent: UIRebalanceIntent, vaultAddress: string, shareMint: string, owner: string): ObservedOperation | null {
  const chain = intent.chain_data;
  if (chain.vault.toBase58() !== vaultAddress || chain.owner.toBase58() !== owner) throw new Error("Native intent identity mismatch");
  if (chain.currentAction === RebalanceAction.NotActive) return null;
  const deposit = chain.rebalanceType === RebalanceType.Deposit;
  const withdrawal = chain.rebalanceType === RebalanceType.Withdraw;
  if (!deposit && !withdrawal) throw new Error("Native intent type is unavailable");
  const phase = chain.currentAction === RebalanceAction.DepositTokens ? deposit ? "AWAITING_LOCK" : "REDEMPTION_CLAIM"
    : chain.currentAction === RebalanceAction.UpdatePrices ? "PRICING"
    : intent.mint_data ? "CLEANUP" : "AUCTION";
  const kind = deposit ? "deposit" : "withdraw";
  return { operationId: `native-${kind}-${intent.formatted_data.pubkey}`, identity: { vaultAccount: vaultAddress, shareMint }, owner, kind, phase, nativeIntent: intent.formatted_data.pubkey, complete: false, blockers: [deposit ? "Deposit pending settlement" : "Cash out pending settlement"] };
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
export async function readPublishedIndexPosition(index: CreatedIndex, owner: string, native?: NativeVaultBuilders): Promise<IndexSharePosition> {
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
  return {
    indexId: index.indexId, indexName: index.name, owner, shareMint: index.shareMint,
    shareDecimals: mint.decimals, sharesRaw: shares.toString(), shareSupplyRaw: mint.supply.toString(),
    ...(pendingOperations.length ? { pendingOperations } : {}),
  };
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
