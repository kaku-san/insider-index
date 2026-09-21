import { getRebalanceIntentPda } from "@symmetry-hq/sdk/dist/instructions/pda.js";
import type { TxPayload, TxPayloadBatchSequence } from "@symmetry-hq/sdk/dist/txUtils.js";
import { PublicKey, VersionedTransaction } from "@solana/web3.js";
import { createServiceSupabase } from "@/lib/supabase";
import { address, hashObject, rawAmount, sdkRawAmount, sha256 } from "./amounts.ts";
import { kakuSanBuilders } from "./kaku-san-create.ts";
import { VAULT_RELEASE } from "./release.ts";
import { networkUsdc, type NativeVaultBuilders } from "./symmetry-adapter.ts";
import { readVaultDefinition, type PersistedVaultDefinition } from "./vault-definition-store.ts";

const HEADERS = { "Cache-Control": "no-store" };
const REQUEST_LIMIT = 4096;

type DepositInput = { owner: string; amountRaw: string; idempotencyKey?: string };
type PreparedTransaction = {
  stepId: string;
  messageBase64: string;
  messageHash: string;
  requiredSigners: string[];
  allowedProgramIds: string[];
  maxDebits: { owner: string; mint: string; amountRaw: string }[];
  expectedRecipients: { owner: string; mint: string }[];
  recentBlockhash: string;
  lastValidBlockHeight: number;
};

export type IndexDepositDependencies = {
  loadDefinition: (indexId: string) => Promise<PersistedVaultDefinition | null>;
  nativeBuilder: () => NativeVaultBuilders;
  release: Pick<typeof VAULT_RELEASE, "publicFundsEnabled">;
};

function defaultDependencies(): IndexDepositDependencies {
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
  return Response.json({ error: error instanceof Error ? error.message : "Deposit preparation is unavailable." }, { status, headers: HEADERS });
}

function usdcDisplayToRaw(value: unknown): string {
  const text = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : typeof value === "string" ? value : "";
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(text)) throw new Error("USDC amount is invalid.");
  const [whole, fraction = ""] = text.split(".");
  return (BigInt(whole) * 1_000_000n + BigInt((fraction + "000000").slice(0, 6))).toString();
}

export function parseIndexDepositRequest(body: unknown): DepositInput {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("A deposit request is required.");
  const input = body as Record<string, unknown>;
  if (Object.keys(input).some(key => !["owner", "amountUsdc", "amountRaw", "idempotencyKey"].includes(key))) throw new Error("Unexpected deposit field.");
  if (typeof input.owner !== "string") throw new Error("Wallet owner is required.");
  if (input.amountRaw != null && input.amountUsdc != null) throw new Error("Provide either amountRaw or amountUsdc, not both.");
  if (input.amountRaw == null && input.amountUsdc == null) throw new Error("USDC amount is required.");
  const amountRaw = input.amountRaw != null ? input.amountRaw : usdcDisplayToRaw(input.amountUsdc);
  if (typeof amountRaw !== "string") throw new Error("USDC amount is required.");
  if (input.idempotencyKey != null && (typeof input.idempotencyKey !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(input.idempotencyKey))) throw new Error("Idempotency key is invalid.");
  address(input.owner);
  rawAmount(amountRaw, true);
  sdkRawAmount(amountRaw);
  return { owner: input.owner, amountRaw, ...(typeof input.idempotencyKey === "string" ? { idempotencyKey: input.idempotencyKey } : {}) };
}

function requireDepositGate(definition: PersistedVaultDefinition, release: Pick<typeof VAULT_RELEASE, "publicFundsEnabled">) {
  if (definition.network !== "mainnet-beta") throw new Error("This vault is not on mainnet.");
  if (!definition.vaultAddress || !definition.shareMint) throw new Error("This index does not have a created vault.");
  address(definition.vaultAddress); address(definition.shareMint);
  if (definition.depositsEnabled !== true) throw new Error("This vault is not accepting deposits.");
  if (release.publicFundsEnabled !== true) throw new Error("Investing is not open for signatures.");
}

function transactionFromPayload(tx: TxPayload, stepId: string, owner: string, maxDebits: PreparedTransaction["maxDebits"]): PreparedTransaction {
  if (tx.payer !== owner) throw new Error("Prepared transaction payer does not match the investing wallet.");
  const lastValidBlockHeight = tx.last_valid_block_height;
  if (!tx.tx_b64 || typeof lastValidBlockHeight !== "number" || !Number.isSafeInteger(lastValidBlockHeight) || lastValidBlockHeight <= 0) throw new Error("Prepared transaction is missing its expiry.");
  const parsed = VersionedTransaction.deserialize(Buffer.from(tx.tx_b64, "base64"));
  const signers = parsed.message.staticAccountKeys.slice(0, parsed.message.header.numRequiredSignatures).map(key => key.toBase58());
  if (signers.length !== 1 || signers[0] !== owner || parsed.signatures.some(signature => signature.some(byte => byte !== 0))) throw new Error("Prepared transaction requires an unexpected signer.");
  if (parsed.message.staticAccountKeys[0]?.toBase58() !== owner || parsed.message.recentBlockhash !== tx.recent_blockhash) throw new Error("Prepared transaction identity mismatch.");
  const allowedProgramIds = [...new Set(tx.instructions.map(instruction => address(instruction.program_id)))];
  const compiledPrograms = parsed.message.compiledInstructions.map(instruction => parsed.message.staticAccountKeys[instruction.programIdIndex]?.toBase58());
  if (!allowedProgramIds.length || compiledPrograms.some(program => !program) || new Set(compiledPrograms).size !== allowedProgramIds.length || compiledPrograms.some(program => !allowedProgramIds.includes(program!))) throw new Error("Prepared transaction instructions do not match the SDK draft.");
  return {
    stepId,
    messageBase64: tx.tx_b64,
    messageHash: sha256(parsed.message.serialize()),
    requiredSigners: signers,
    allowedProgramIds,
    maxDebits,
    expectedRecipients: [],
    recentBlockhash: tx.recent_blockhash,
    lastValidBlockHeight,
  };
}

function transactionsFromPayload(payload: TxPayloadBatchSequence, prefix: string, owner: string, amountRaw?: string): PreparedTransaction[] {
  const all = payload.batches.flatMap(batch => batch.transactions);
  if (!all.length) throw new Error("The vault did not prepare a transaction.");
  return all.map((tx, index) => transactionFromPayload(tx, `${prefix}-${index + 1}`, owner,
    amountRaw && index === all.length - 1 ? [{ owner, mint: networkUsdc("mainnet-beta"), amountRaw }] : []));
}

async function assertLiveVault(native: NativeVaultBuilders, definition: PersistedVaultDefinition, owner: string) {
  await native.assertNetwork();
  if (native.network !== "mainnet-beta") throw new Error("Mainnet vault builder required.");
  const vault = await native.sdk.fetchVault(definition.vaultAddress!);
  if (vault.ownAddress.toBase58() !== definition.vaultAddress || vault.mint.toBase58() !== definition.shareMint) throw new Error("Native vault identity mismatch.");
  const intent = getRebalanceIntentPda(new PublicKey(definition.vaultAddress!), new PublicKey(owner));
  if (await native.connection.getAccountInfo(intent, "confirmed")) throw new Error("An existing deposit is awaiting keeper minting.");
}

export async function prepareIndexDeposit(indexId: string, input: DepositInput, dependencies: IndexDepositDependencies = defaultDependencies()) {
  const definition = await dependencies.loadDefinition(indexId);
  if (!definition) throw new Error("Index not found.");
  requireDepositGate(definition, dependencies.release);
  const native = dependencies.nativeBuilder();
  await assertLiveVault(native, definition, input.owner);
  const buy = await native.sdk.buyVaultTx({
    buyer: input.owner,
    vault_mint: definition.shareMint!,
    contributions: [{ mint: networkUsdc("mainnet-beta"), amount: sdkRawAmount(input.amountRaw) }],
    rebalance_slippage_bps: 100,
    per_trade_rebalance_slippage_bps: 50,
  });
  const lock = await native.sdk.lockDepositsTx({ buyer: input.owner, vault_mint: definition.shareMint! });
  const operationId = `deposit-${hashObject({ indexId, owner: input.owner, amountRaw: input.amountRaw, key: input.idempotencyKey ?? "" }).slice(0, 32)}`;
  return {
    network: "mainnet-beta" as const,
    operationId,
    phase: "AWAITING_SIGNATURE",
    requires: "user-signature" as const,
    transactions: [...transactionsFromPayload(buy, "deposit", input.owner, input.amountRaw), ...transactionsFromPayload(lock, "lock", input.owner)],
    configHash: hashObject({ indexId, vault: definition.vaultAddress, shareMint: definition.shareMint, depositsEnabled: definition.depositsEnabled }),
    constraints: [{ label: "Settlement", value: "Your deposit locks after wallet approval. A keeper mints shares later." }],
    costs: { hostEntryFeeBps: definition.hostEntryFeeBps ?? 25, hostExitFeeBps: definition.hostExitFeeBps ?? 0, estimatedOnly: true },
    blockers: [],
  };
}

/** Public wallet prepare has no cycle policy, journal, access message, or recovery rail. */
export async function handleIndexDepositPrepare(request: Request, indexId: string, dependencies: IndexDepositDependencies = defaultDependencies()): Promise<Response> {
  if (!/^(insiderindex-|idx-theme-)[a-z0-9-]+$/.test(indexId)) return plainError(new Error("Invalid index ID."), 400);
  let input: DepositInput;
  try {
    const text = await request.text();
    if (text.length > REQUEST_LIMIT) return plainError(new Error("Request too large."), 413);
    input = parseIndexDepositRequest(JSON.parse(text));
  } catch (error) {
    return plainError(error, 400);
  }
  try {
    return Response.json(await prepareIndexDeposit(indexId, input, dependencies), { headers: HEADERS });
  } catch (error) {
    return plainError(error);
  }
}
