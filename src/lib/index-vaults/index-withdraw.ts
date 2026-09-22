import { createHash } from "node:crypto";
import { ComputeBudgetProgram, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { getRebalanceIntentPda } from "@symmetry-hq/sdk/dist/instructions/pda.js";
import { createServiceSupabase } from "@/lib/supabase";
import { address, hashObject, rawAmount, sdkRawAmount } from "./amounts.ts";
import { validateAndSimulate } from "./transaction-policy.ts";
import { kakuSanBuilders } from "./kaku-san-create.ts";
import { VAULT_RELEASE } from "./release.ts";
import { networkUsdc, SYMMETRY_PROGRAM_ID, type NativeVaultBuilders } from "./symmetry-adapter.ts";
import { readVaultDefinition, type PersistedVaultDefinition } from "./vault-definition-store.ts";
import { PUBLIC_MAG7 } from "./public-cycle-parse.ts";

const HEADERS = { "Cache-Control": "no-store" };
const REQUEST_LIMIT = 4096;
const INIT_REBALANCE_INTENT = Buffer.from([127, 215, 41, 110, 244, 179, 131, 7]);
const CREATE_REBALANCE_INTENT = Buffer.from([120, 80, 245, 123, 212, 149, 163, 47]);
const RESIZE_REBALANCE_INTENT = Buffer.from([71, 204, 243, 183, 209, 118, 111, 94]);

type WithdrawalInput = { owner: string; shareAmountRaw: string; requestedExitMode: "verified-native-usdc"; idempotencyKey?: string };
type PayloadTransaction = { tx_b64: string; recent_blockhash: string; last_valid_block_height: number; payer: string; lookup_tables: unknown[] };
export type IndexWithdrawDependencies = {
  loadDefinition: (indexId: string) => Promise<PersistedVaultDefinition | null>;
  nativeBuilder: () => NativeVaultBuilders;
  release: Pick<typeof VAULT_RELEASE, "publicFundsEnabled">;
};

function defaultDependencies(): IndexWithdrawDependencies {
  return {
    loadDefinition: async indexId => {
      const db = createServiceSupabase();
      if (!db) throw new Error("Vault definitions are unavailable.");
      return readVaultDefinition(db, indexId);
    },
    nativeBuilder: () => kakuSanBuilders(false),
    release: VAULT_RELEASE,
  };
}
function plainError(error: unknown, status = 503) {
  return Response.json({ error: error instanceof Error ? error.message : "Cash out preparation is unavailable." }, { status, headers: HEADERS });
}

export function parseIndexWithdrawalRequest(body: unknown): WithdrawalInput {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("A cash out request is required.");
  const input = body as Record<string, unknown>;
  if (Object.keys(input).some(key => !["owner", "shareAmountRaw", "requestedExitMode", "idempotencyKey"].includes(key))) throw new Error("Unexpected cash out field.");
  if (typeof input.owner !== "string") throw new Error("Wallet owner is required.");
  if (typeof input.shareAmountRaw !== "string") throw new Error("Share amount is required.");
  if (input.requestedExitMode !== "verified-native-usdc") throw new Error("USDC cash out is required.");
  if (input.idempotencyKey != null && (typeof input.idempotencyKey !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(input.idempotencyKey))) throw new Error("Idempotency key is invalid.");
  address(input.owner); rawAmount(input.shareAmountRaw, true); sdkRawAmount(input.shareAmountRaw);
  return { owner: input.owner, shareAmountRaw: input.shareAmountRaw, requestedExitMode: "verified-native-usdc", ...(typeof input.idempotencyKey === "string" ? { idempotencyKey: input.idempotencyKey } : {}) };
}

function requireWithdrawalGate(indexId: string, definition: PersistedVaultDefinition, release: Pick<typeof VAULT_RELEASE, "publicFundsEnabled">) {
  if (indexId !== PUBLIC_MAG7.indexId || definition.vaultAddress !== PUBLIC_MAG7.vault || definition.shareMint !== PUBLIC_MAG7.shareMint) throw new Error("Cash out is not available for this vault.");
  if (definition.network !== "mainnet-beta") throw new Error("This vault is not on mainnet.");
  if (!release.publicFundsEnabled) throw new Error("Cash out is not open for signatures.");
  address(definition.vaultAddress); address(definition.shareMint);
}
function instructionsFrom(transaction: VersionedTransaction): TransactionInstruction[] {
  if (transaction.message.addressTableLookups.length) throw new Error("Cash out transaction uses an unsupported lookup table.");
  return TransactionMessage.decompile(transaction.message).instructions;
}
function tokenMintsHash(mints: string[]): Buffer {
  let hash = Buffer.alloc(32);
  for (const mint of mints) hash = createHash("sha256").update(hash).update(new PublicKey(mint).toBuffer()).digest();
  return hash;
}
/** Empty keep_tokens is the documented auction path: the keeper settles vault assets to USDC
 * before the owner claims. It deliberately never gives a keeper authority over wallet tokens. */
function assertUsdcAuctionIntent(instructions: TransactionInstruction[], owner: string, vaultAddress: string, shareMint: string, sharesRaw: string, vaultMints: string[]) {
  const symmetry = instructions.filter(ix => ix.programId.toBase58() === SYMMETRY_PROGRAM_ID);
  if (symmetry.length !== 3 || !symmetry[0].data.equals(CREATE_REBALANCE_INTENT) || !symmetry[1].data.equals(RESIZE_REBALANCE_INTENT)) throw new Error("Cash out transaction has an unexpected native intent.");
  const create = symmetry[0], resize = symmetry[1], init = symmetry[2];
  const ownerKey = new PublicKey(owner), vault = new PublicKey(vaultAddress), mint = new PublicKey(shareMint);
  if (create.keys.length !== 9 || !create.keys[0]?.pubkey.equals(ownerKey) || !create.keys[0].isSigner || !create.keys[1]?.pubkey.equals(ownerKey) || !create.keys[2]?.pubkey.equals(vault) || !create.keys[3]?.isWritable || resize.keys.length !== 1 || !resize.keys[0]?.pubkey.equals(create.keys[3].pubkey) || !resize.keys[0].isWritable) throw new Error("Cash out intent accounts are invalid.");
  if (!init.data.subarray(0, 8).equals(INIT_REBALANCE_INTENT) || init.data.length !== 126 || init.data[40] !== 1 || init.data.readBigUInt64LE(69) !== BigInt(sharesRaw) || !init.data.subarray(77, 109).equals(tokenMintsHash(vaultMints)) || init.data.readBigUInt64LE(109) !== 0n || init.data.readBigUInt64LE(117) !== 0n || init.data[125] !== 0) throw new Error("Cash out transaction is not the USDC auction path.");
  if (init.keys.length !== 18 || !init.keys[0]?.pubkey.equals(ownerKey) || !init.keys[0].isSigner || !init.keys[1]?.pubkey.equals(ownerKey) || !init.keys[2]?.pubkey.equals(vault) || !init.keys[3]?.pubkey.equals(create.keys[3].pubkey) || !init.keys[4]?.pubkey.equals(create.keys[4].pubkey) || !init.keys[5]?.pubkey.equals(mint) || !init.keys[14]?.pubkey.equals(new PublicKey(SYMMETRY_PROGRAM_ID))) throw new Error("Cash out transaction accounts are invalid.");
  const system = instructions.filter(ix => ix.programId.toBase58() === "11111111111111111111111111111111");
  const sync = instructions.filter(ix => ix.programId.equals(TOKEN_PROGRAM_ID));
  if (system.length !== 1 || system[0].data.length !== 12 || system[0].data.readUInt32LE(0) !== 2 || system[0].data.readBigUInt64LE(4) <= 0n || system[0].keys.length !== 2 || !system[0].keys[0]?.pubkey.equals(ownerKey) || !system[0].keys[0].isSigner || !system[0].keys[1]?.pubkey.equals(init.keys[9].pubkey) || sync.length !== 1 || sync[0].data.length !== 1 || sync[0].data[0] !== 17 || sync[0].keys.length !== 1 || !sync[0].keys[0]?.pubkey.equals(init.keys[9].pubkey)) throw new Error("Cash out bounty setup is invalid.");
  if (instructions.some(ix => ix.programId.equals(TOKEN_2022_PROGRAM_ID) || ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID))) throw new Error("Cash out transaction contains unsupported token setup.");
}
function transactionPolicy(instructions: TransactionInstruction[], owner: string, shareMint: string, sharesRaw: string) {
  const allowed = new Set([SYMMETRY_PROGRAM_ID, ComputeBudgetProgram.programId.toBase58(), TOKEN_PROGRAM_ID.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58(), ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(), "11111111111111111111111111111111"]);
  const programs = [...new Set(instructions.map(ix => ix.programId.toBase58()))];
  if (programs.some(program => !allowed.has(program))) throw new Error("Cash out transaction uses an unapproved program.");
  return {
    payer: owner, signers: [owner], programs,
    writableAccounts: [...new Set(instructions.flatMap(ix => ix.keys.filter(key => key.isWritable).map(key => key.pubkey.toBase58()))), owner],
    expectedInstructions: instructions,
    maxDebits: [{ owner, mint: shareMint, amountRaw: sharesRaw }],
    recipients: [{ owner, mint: networkUsdc("mainnet-beta") }], minima: [], maxComputeUnits: 1_400_000, maxMicroLamports: 100_000n,
    decode: () => ({ debits: [], recipients: [], minima: [] }),
  };
}

export async function prepareIndexWithdrawal(indexId: string, input: WithdrawalInput, dependencies: IndexWithdrawDependencies = defaultDependencies()) {
  const definition = await dependencies.loadDefinition(indexId);
  if (!definition) throw new Error("Index not found.");
  requireWithdrawalGate(indexId, definition, dependencies.release);
  const native = dependencies.nativeBuilder();
  await native.assertNetwork();
  if (native.network !== "mainnet-beta") throw new Error("Mainnet vault builder required.");
  const vault = await native.sdk.fetchVault(definition.vaultAddress!);
  if (vault.ownAddress.toBase58() !== definition.vaultAddress || vault.mint.toBase58() !== definition.shareMint) throw new Error("Native vault identity mismatch.");
  const intent = getRebalanceIntentPda(new PublicKey(definition.vaultAddress!), new PublicKey(input.owner));
  if (await native.connection.getAccountInfo(intent, "confirmed")) throw new Error("A cash out is already settling for this wallet.");
  const payload = await native.sdk.sellVaultTx({ seller: input.owner, vault_mint: definition.shareMint!, withdraw_amount: sdkRawAmount(input.shareAmountRaw), keep_tokens: [], rebalance_slippage_bps: 100, per_trade_rebalance_slippage_bps: 50 });
  const transactions = payload.batches.flatMap(batch => batch.transactions) as PayloadTransaction[];
  if (transactions.length !== 1) throw new Error("Cash out prepared an unexpected number of approvals.");
  const source = transactions[0];
  if (source.payer !== input.owner || !source.tx_b64 || !Number.isSafeInteger(source.last_valid_block_height) || source.last_valid_block_height <= 0 || source.lookup_tables.length) throw new Error("Cash out transaction is invalid.");
  const parsed = VersionedTransaction.deserialize(Buffer.from(source.tx_b64, "base64"));
  if (parsed.signatures.some(signature => signature.some(byte => byte !== 0)) || parsed.message.staticAccountKeys[0]?.toBase58() !== input.owner || parsed.message.recentBlockhash !== source.recent_blockhash) throw new Error("Cash out transaction identity mismatch.");
  const instructions = instructionsFrom(parsed);
  assertUsdcAuctionIntent(instructions, input.owner, definition.vaultAddress!, definition.shareMint!, input.shareAmountRaw, vault.composition.slice(0, vault.numTokens).map(token => token.mint.toBase58()));
  const transaction = await validateAndSimulate(native.connection, { stepId: "cash-out-auction", transactionBase64: source.tx_b64, lastValidBlockHeight: source.last_valid_block_height }, transactionPolicy(instructions, input.owner, definition.shareMint!, input.shareAmountRaw));
  const operationId = `withdraw-${hashObject({ indexId, owner: input.owner, sharesRaw: input.shareAmountRaw, key: input.idempotencyKey ?? "" }).slice(0, 32)}`;
  return {
    network: "mainnet-beta" as const, operationId, phase: "AWAITING_SIGNATURE", requires: "user-signature" as const, transactions: [transaction],
    configHash: hashObject({ indexId, vault: definition.vaultAddress, shareMint: definition.shareMint, mode: "usdc-auction" }),
    constraints: [{ label: "Settlement", value: "One wallet approval starts the vault auction. The keeper settles it, then USDC lands in this wallet." }, { label: "Wallet approvals", value: "1 approval now" }],
    costs: { hostEntryFeeBps: definition.hostEntryFeeBps ?? 25, hostExitFeeBps: definition.hostExitFeeBps ?? 0, estimatedOnly: true }, blockers: [],
  };
}
export async function handleIndexWithdrawalPrepare(request: Request, indexId: string, dependencies: IndexWithdrawDependencies = defaultDependencies()): Promise<Response> {
  if (!/^(insiderindex-|idx-theme-)[a-z0-9-]+$/.test(indexId)) return plainError(new Error("Invalid index ID."), 400);
  let input: WithdrawalInput;
  try {
    const text = await request.text();
    if (text.length > REQUEST_LIMIT) return plainError(new Error("Request too large."), 413);
    input = parseIndexWithdrawalRequest(JSON.parse(text));
  } catch (error) { return plainError(error, 400); }
  try { return Response.json(await prepareIndexWithdrawal(indexId, input, dependencies), { headers: HEADERS }); }
  catch (error) { return plainError(error); }
}
