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

/** A native intent is the only pending-deposit source; a prepare response is never a receipt. */
export function pendingNativeDeposit(intent: UIRebalanceIntent, vaultAddress: string, shareMint: string, owner: string): ObservedOperation | null {
  const chain = intent.chain_data;
  if (chain.vault.toBase58() !== vaultAddress || chain.owner.toBase58() !== owner || chain.rebalanceType !== RebalanceType.Deposit) throw new Error("Native deposit intent identity mismatch");
  if (chain.currentAction === RebalanceAction.NotActive) return null;
  const phase = chain.currentAction === RebalanceAction.DepositTokens ? "AWAITING_LOCK"
    : chain.currentAction === RebalanceAction.UpdatePrices ? "PRICING"
    : intent.mint_data ? "CLEANUP" : "AUCTION";
  return { operationId: `native-deposit-${intent.formatted_data.pubkey}`, identity: { vaultAccount: vaultAddress, shareMint }, owner, kind: "deposit", phase, nativeIntent: intent.formatted_data.pubkey, complete: false, blockers: ["Deposit pending settlement"] };
}

async function pendingNativeDeposits(native: NativeVaultBuilders, vaultAddress: string, shareMint: string, owner: string): Promise<ObservedOperation[]> {
  const intentAddress = getRebalanceIntentPda(new PublicKey(vaultAddress), new PublicKey(owner)).toBase58();
  if (!await native.connection.getAccountInfo(new PublicKey(intentAddress), "confirmed")) return [];
  const pending = pendingNativeDeposit(await native.sdk.fetchRebalanceIntent(intentAddress), vaultAddress, shareMint, owner);
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
  const pendingOperations = await pendingNativeDeposits(activeNative, index.vaultAddress, index.shareMint, owner);
  return {
    indexId: index.indexId, indexName: index.name, owner, shareMint: index.shareMint,
    shareDecimals: mint.decimals, sharesRaw: shares.toString(),
    ...(pendingOperations.length ? { pendingOperations } : {}),
  };
}

/** Only positive chain balances are portfolio positions. A read failure is not converted to zero. */
export async function readOwnedIndexPositions(owner: string, indexes: readonly PublicVaultDefinition[], readPosition: PositionReader = readPublishedIndexPosition): Promise<IndexSharePosition[]> {
  walletOwner(owner);
  const positions = await Promise.all(indexes.filter(createdIndex).map(index => readPosition(index, owner)));
  return positions.filter(position => BigInt(position.sharesRaw) > 0n);
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
