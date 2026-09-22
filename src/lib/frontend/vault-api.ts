import { bytesToHex } from "@noble/hashes/utils.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { VersionedMessage, VersionedTransaction } from "@solana/web3.js";
import { ApiError, readApi, writeApi } from "./api";

export type Network = "devnet" | "mainnet-beta";
export type RawAmount = string;
const rawAmountPattern = /^(0|[1-9][0-9]*)$/;

export type Evidence = { observedSlot?: number; observedAt?: string; source?: string; receipt?: string };
export type VaultIdentity = {
  network?: Network;
  programId?: string;
  vaultAccount: string;
  shareMint: string;
  shareDecimals?: number;
  hostTreasury?: string;
  indexId?: string;
};

export type CostPreview = {
  hostEntryFeeBps?: number;
  hostExitFeeBps?: number;
  networkBudgetLamports?: RawAmount;
  bountyMaxLockedRaw?: RawAmount;
  quotedSwapCost?: string;
  estimatedOnly?: boolean;
};

export type UnsignedMessage = {
  stepId: string;
  messageBase64: string;
  messageHash: string;
  requiredSigners: string[];
  allowedProgramIds: string[];
  maxDebits: { owner: string; mint: string; amountRaw: RawAmount }[];
  expectedRecipients: { owner: string; mint: string }[];
  recentBlockhash: string;
  lastValidBlockHeight: number;
  simulation?: { ok: true; slot: number; logsHash: string; error?: string };
};

export type PreparedStep = {
  network: Network;
  operationId: string;
  nativeIntent?: string;
  phase: string;
  requires: "user-signature" | "deployer-signature" | "strategy-service-signature" | "keeper-task" | "wait" | "exception-recovery";
  transactions: UnsignedMessage[];
  configHash?: string;
  constraints?: { label: string; value: string; strength?: string }[];
  costs?: CostPreview;
  blockers: string[];
  estimate?: {
    sharesRaw?: RawAmount;
    sharesText?: string;
    returnedUsdcRaw?: RawAmount;
    outputSummary?: string;
  };
};

export type NativeClaim = {
  owner?: string;
  mint: string;
  tokenProgram?: string;
  amountRemainingRaw: RawAmount;
  accountExists?: boolean;
  transferBlocked?: boolean;
  symbol?: string;
};

export type ConfirmedCredit = {
  id: string;
  operationId?: string;
  mint: string;
  recipientOwner?: string;
  creditedRaw: RawAmount;
  soldRaw?: RawAmount;
  signature?: string;
  symbol?: string;
};

export function creditHasRemainingAmount(credit: Pick<ConfirmedCredit, "creditedRaw" | "soldRaw">): boolean {
  try {
    return rawAmountPattern.test(credit.creditedRaw) && rawAmountPattern.test(credit.soldRaw ?? "0") && BigInt(credit.creditedRaw) > BigInt(credit.soldRaw ?? "0");
  } catch {
    return false;
  }
}

export type ObservedOperation = {
  operationId: string;
  identity?: VaultIdentity;
  owner?: string;
  kind: "deposit" | "withdraw" | "fund-rebalance" | string;
  phase: string;
  nativeIntent?: string;
  confirmedSharesReceivedRaw?: RawAmount;
  confirmedSharesBurnedRaw?: RawAmount;
  outstandingClaims?: NativeClaim[];
  credits?: ConfirmedCredit[];
  complete?: boolean;
  blockers?: string[];
  evidence?: Evidence[];
  nextAction?: string | null;
};

export type VaultReadiness = {
  indexId: string;
  status?: string;
  phase?: string;
  identity?: VaultIdentity | null;
  vault?: VaultIdentity | null;
  ready?: boolean;
  depositEnabled?: boolean;
  redeemEnabled?: boolean;
  blockers?: string[];
  observedSlot?: number;
  observedAt?: string;
  shareSupplyRaw?: RawAmount;
  sharePrice?: string | null;
  sharePriceBasis?: string | null;
  hostEntryFeeBps?: number;
  hostExitFeeBps?: number;
  targetWeights?: { ticker?: string; mint: string; weightBps: number }[];
  actualWeights?: { ticker?: string; mint: string; weightBps: number }[];
};

export type IndexSharePosition = {
  indexId: string;
  indexName?: string;
  owner: string;
  shareMint?: string;
  shareDecimals?: number;
  sharesRaw: RawAmount;
  sharesText?: string;
  markedValueUsdc?: string | null;
  markedAt?: string | null;
  priceBasis?: string | null;
  pendingOperations?: ObservedOperation[];
  outstandingClaims?: NativeClaim[];
};

export type VaultUiState = "NO_VAULT" | "PREVIEW_ONLY" | "PREPARE_BLOCKED" | "LIVE_DEPOSIT" | "PENDING" | "HAS_SHARES";

export function hasIndexShares(position?: IndexSharePosition | null): boolean {
  try { return Boolean(position && rawAmountPattern.test(position.sharesRaw) && BigInt(position.sharesRaw) > 0n); }
  catch { return false; }
}

export const DEPOSIT_PHASES = [
  "DRAFT","AWAITING_SIGNATURE","SUBMITTED","INTENT_CONFIRMED","AWAITING_LOCK","PRICING","AUCTION","SETTLING","SHARES_RECEIVED","RETURN_PENDING","CLEANUP","COMPLETE"
] as const;
export const WITHDRAW_PHASES = [
  "DRAFT","AWAITING_SIGNATURE","SUBMITTED","REDEMPTION_CLAIM","CLAIM_PENDING","TOKENS_RECEIVED","CONVERTING","COMPLETE_IN_KIND","PARTIAL_USDC","COMPLETE_USDC"
] as const;

export function depositIsEnabled(readiness?: VaultReadiness | null): boolean {
  return readiness?.depositEnabled !== false && Boolean(readiness?.depositEnabled || readiness?.ready);
}

export function uiStateFrom(readiness: VaultReadiness | null, position?: IndexSharePosition | null, operation?: ObservedOperation | null): VaultUiState {
  if (operation && !operation.complete) return "PENDING";
  if (hasIndexShares(position)) return "HAS_SHARES";
  if (!readiness?.identity && !readiness?.vault) return "NO_VAULT";
  if (depositIsEnabled(readiness)) return "LIVE_DEPOSIT";
  if ((readiness.phase || readiness.status || "").toUpperCase().includes("BLOCK")) return "PREPARE_BLOCKED";
  return "PREVIEW_ONLY";
}

export type VaultIndexResponse = {
  index?: {
    vaultAddress?: string | null;
    shareMint?: string | null;
    network?: Network | null;
    constituents?: { ticker?: string; mint?: string; weight_bps?: number }[];
  };
  depositsEnabled?: boolean;
  depositReason?: string | null;
  publicFundsEnabled?: boolean;
};

function publishedTargetWeights(payload: VaultIndexResponse): VaultReadiness["targetWeights"] {
  const constituents = payload.index?.constituents;
  if (!Array.isArray(constituents)) return undefined;
  const weights = constituents.flatMap(row => typeof row?.mint === "string" && row.mint && typeof row.weight_bps === "number" && Number.isInteger(row.weight_bps) && row.weight_bps > 0
    ? [{ mint: row.mint, weightBps: row.weight_bps, ...(typeof row.ticker === "string" && row.ticker ? { ticker: row.ticker } : {}) }]
    : []);
  return weights.length === constituents.length && weights.reduce((total, row) => total + row.weightBps, 0) === 10_000 ? weights : undefined;
}

function publicBlocker(payload: VaultIndexResponse, hasIdentity: boolean): string {
  if (!hasIdentity) return "This index is for research. Investing is not available yet.";
  if (payload.depositsEnabled !== true) return "This vault is not accepting deposits yet.";
  if (payload.publicFundsEnabled !== true) return "Investing isn't open for signatures yet.";
  return "Deposit readiness could not be verified.";
}

/** Signing eligibility for native prepare. A created vault and per-index deposit gate are not
 * enough: the global public-funds release must also be on before the wallet is asked to sign. */
export function vaultReadinessFromIndex(indexId: string, payload: VaultIndexResponse): VaultReadiness {
  const vaultAddress = payload.index?.vaultAddress;
  const shareMint = payload.index?.shareMint;
  const network = payload.index?.network;
  const hasIdentity = typeof vaultAddress === "string" && addressPattern.test(vaultAddress)
    && typeof shareMint === "string" && addressPattern.test(shareMint)
    && (network === "mainnet-beta" || network === "devnet");
  const depositEnabled = hasIdentity && payload.depositsEnabled === true && payload.publicFundsEnabled === true;
  const targetWeights = publishedTargetWeights(payload);
  return {
    indexId,
    ...(targetWeights ? { targetWeights } : {}),
    depositEnabled,
    ready: depositEnabled,
    redeemEnabled: hasIdentity,
    blockers: depositEnabled ? [] : [publicBlocker(payload, hasIdentity)],
    identity: hasIdentity ? { network, vaultAccount: vaultAddress, shareMint, indexId } : null,
  };
}

export type PublicVaultDepositState = {
  vaultAddress?: string | null;
  shareMint?: string | null;
  network?: Network | null;
  depositsEnabled?: boolean;
  publicFundsEnabled?: boolean;
};

export function publicVaultDepositIsEnabled(state: PublicVaultDepositState): boolean {
  return vaultReadinessFromIndex("public-index", {
    index: { vaultAddress: state.vaultAddress, shareMint: state.shareMint, network: state.network },
    depositsEnabled: state.depositsEnabled,
    publicFundsEnabled: state.publicFundsEnabled,
  }).depositEnabled === true;
}

export function hasPublicVaultIdentity(state: PublicVaultDepositState): boolean {
  return vaultReadinessFromIndex("public-index", {
    index: { vaultAddress: state.vaultAddress, shareMint: state.shareMint, network: state.network },
  }).identity != null;
}

/** Public Live/Invest requires the created vault, its deposit gate, and the active public signing path. */
export function publicIndexIsLive(state: PublicVaultDepositState): boolean {
  return publicVaultDepositIsEnabled(state);
}

export type PublicIndexStatus = "Live" | "Coming soon" | "Research";

export function publicIndexStatus(state: PublicVaultDepositState): PublicIndexStatus {
  if (publicIndexIsLive(state)) return "Live";
  if (hasPublicVaultIdentity(state)) return "Coming soon";
  return "Research";
}

export function publicIndexStatusCopy(status: PublicIndexStatus): string {
  if (status === "Live") return "You can invest in this index.";
  if (status === "Coming soon") return "This index has a vault. Investing is not open yet.";
  return "This index is for research. Investing is not available yet.";
}

export async function getVaultReadiness(indexId: string): Promise<VaultReadiness | null> {
  try {
    return vaultReadinessFromIndex(indexId, await readApi<VaultIndexResponse>(`/api/vault-indexes/${encodeURIComponent(indexId)}`));
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

export async function getIndexPosition(indexId: string, owner: string): Promise<IndexSharePosition | null> {
  try {
    return await readApi<IndexSharePosition>(`/api/indexes/${encodeURIComponent(indexId)}/position?wallet=${encodeURIComponent(owner)}`);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

const addressPattern = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("The prepare response is invalid.");
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`The prepared ${label} is invalid.`);
  return value;
}

function addressValue(value: unknown, label: string): string {
  const result = string(value, label);
  if (!addressPattern.test(result)) throw new Error(`The prepared ${label} is invalid.`);
  return result;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`The prepared ${label} is invalid.`);
  return value;
}

function decodedTransaction(value: string): Uint8Array {
  if (typeof atob !== "function") throw new Error("The wallet cannot validate the prepared transaction.");
  try { return Uint8Array.from(atob(value), character => character.charCodeAt(0)); }
  catch { throw new Error("The prepared transaction is not valid base64."); }
}

function encodedTransaction(value: Uint8Array): string {
  if (typeof btoa !== "function") throw new Error("The wallet cannot validate the prepared transaction.");
  return btoa(Array.from(value, byte => String.fromCharCode(byte)).join(""));
}

/** Accept legacy message-only prepares, but always give the wallet a complete unsigned wire transaction. */
function deserializePreparedTransaction(value: string): VersionedTransaction {
  const bytes = decodedTransaction(value);
  try { return VersionedTransaction.deserialize(bytes); }
  catch {
    try { return new VersionedTransaction(VersionedMessage.deserialize(bytes)); }
    catch { throw new Error("The prepared transaction cannot be decoded."); }
  }
}

function validatedTransaction(value: unknown, owner: string): UnsignedMessage {
  const transaction = record(value);
  const stepId = string(transaction.stepId, "transaction step");
  const messageBase64 = string(transaction.messageBase64, "transaction");
  const messageHash = string(transaction.messageHash, "transaction hash");
  const recentBlockhash = string(transaction.recentBlockhash, "transaction blockhash");
  const lastValidBlockHeight = transaction.lastValidBlockHeight;
  if (typeof lastValidBlockHeight !== "number" || !Number.isSafeInteger(lastValidBlockHeight) || lastValidBlockHeight <= 0) throw new Error("The prepared transaction expiry is invalid.");
  const requiredSigners = array(transaction.requiredSigners, "transaction signers").map((signer, index) => addressValue(signer, `transaction signer ${index + 1}`));
  const allowedProgramIds = array(transaction.allowedProgramIds, "transaction programs").map((program, index) => addressValue(program, `transaction program ${index + 1}`));
  const maxDebits = array(transaction.maxDebits, "transaction debits").map((debit, index) => {
    const item = record(debit); const debitOwner = addressValue(item.owner, `debit owner ${index + 1}`); const mint = addressValue(item.mint, `debit mint ${index + 1}`); const amountRaw = string(item.amountRaw, `debit amount ${index + 1}`);
    if (!rawAmountPattern.test(amountRaw) || debitOwner !== owner) throw new Error("The prepared transaction debit is invalid.");
    return { owner: debitOwner, mint, amountRaw };
  });
  const expectedRecipients = array(transaction.expectedRecipients, "transaction recipients").map((recipient, index) => {
    const item = record(recipient); return { owner: addressValue(item.owner, `recipient owner ${index + 1}`), mint: addressValue(item.mint, `recipient mint ${index + 1}`) };
  });
  const parsed = deserializePreparedTransaction(messageBase64);
  const signers = parsed.message.staticAccountKeys.slice(0, parsed.message.header.numRequiredSignatures).map(key => key.toBase58());
  const compiledPrograms = parsed.message.compiledInstructions.map(instruction => parsed.message.staticAccountKeys[instruction.programIdIndex]?.toBase58());
  if (parsed.signatures.some(signature => signature.some(byte => byte !== 0)) || parsed.message.staticAccountKeys[0]?.toBase58() !== owner || signers.length !== 1 || signers[0] !== owner || requiredSigners.length !== 1 || requiredSigners[0] !== owner || parsed.message.recentBlockhash !== recentBlockhash || bytesToHex(sha256(parsed.message.serialize())) !== messageHash || compiledPrograms.some(program => !program) || new Set(compiledPrograms).size !== new Set(allowedProgramIds).size || compiledPrograms.some(program => !allowedProgramIds.includes(program!))) throw new Error("The prepared transaction does not match this wallet.");
  const simulation = transaction.simulation;
  let validatedSimulation: UnsignedMessage["simulation"];
  if (simulation != null) {
    const checked = record(simulation);
    if (checked.ok !== true || typeof checked.slot !== "number" || !Number.isSafeInteger(checked.slot) || checked.slot < 0 || !/^[a-f0-9]{64}$/.test(string(checked.logsHash, "simulation logs hash"))) throw new Error("The prepared transaction simulation is invalid.");
    validatedSimulation = { ok: true, slot: checked.slot, logsHash: string(checked.logsHash, "simulation logs hash"), ...(typeof checked.error === "string" ? { error: checked.error } : {}) };
  }
  return { stepId, messageBase64: encodedTransaction(parsed.serialize()), messageHash, requiredSigners, allowedProgramIds, maxDebits, expectedRecipients, recentBlockhash, lastValidBlockHeight, ...(validatedSimulation ? { simulation: validatedSimulation } : {}) };
}

export async function validatePreparedStep(payload: unknown, context: { owner: string; network: Network }): Promise<PreparedStep> {
  const owner = addressValue(context.owner, "wallet owner");
  if (context.network !== "devnet" && context.network !== "mainnet-beta") throw new Error("The prepared network is invalid.");
  const step = record(payload);
  const requires = string(step.requires, "authority");
  if (!["user-signature", "deployer-signature", "strategy-service-signature", "keeper-task", "wait", "exception-recovery"].includes(requires)) throw new Error("The prepared authority is invalid.");
  const blockers = array(step.blockers, "blockers");
  if (blockers.some((blocker) => typeof blocker !== "string" || !blocker.trim())) throw new Error("The prepared blockers are invalid.");
  string(step.operationId, "operation ID");
  string(step.phase, "phase");
  string(step.configHash, "configuration hash");
  array(step.constraints, "constraints");
  const transactions = array(step.transactions, "transactions");
  if (requires !== "user-signature") {
    if (transactions.length) throw new Error("A non-user step returned wallet transactions.");
    return { ...(payload as Omit<PreparedStep, "network">), network: context.network };
  }
  if (!transactions.length) throw new Error("The prepared action has no wallet transactions.");
  return { ...(payload as Omit<PreparedStep, "network" | "transactions">), network: context.network, transactions: transactions.map(transaction => validatedTransaction(transaction, owner)) };
}

export async function prepareDeposit(indexId: string, input: { owner: string; amountRaw: RawAmount; idempotencyKey: string; walletProof?: string }, network: Network): Promise<PreparedStep> {
  return validatePreparedStep(await writeApi<unknown>(`/api/indexes/${encodeURIComponent(indexId)}/deposit/prepare`, input), { owner: input.owner, network });
}

export async function prepareWithdrawal(indexId: string, input: { owner: string; shareAmountRaw: RawAmount; requestedExitMode: "in-kind" | "verified-native-usdc"; idempotencyKey: string; walletProof?: string }, network: Network): Promise<PreparedStep> {
  return validatePreparedStep(await writeApi<unknown>(`/api/indexes/${encodeURIComponent(indexId)}/withdraw/prepare`, input), { owner: input.owner, network });
}

export async function prepareNext(operationId: string, owner: string, network: Network, walletProof?: string): Promise<PreparedStep> {
  return validatePreparedStep(await writeApi<unknown>(`/api/operations/${encodeURIComponent(operationId)}/next`, { owner, walletProof }), { owner, network });
}

export async function submitReceipts(operationId: string, owner: string, receipts: { stepId: string; signature: string }[]): Promise<ObservedOperation> {
  return writeApi<ObservedOperation>(`/api/operations/${encodeURIComponent(operationId)}/receipts`, { owner, receipts });
}

export async function getOperation(operationId: string): Promise<ObservedOperation> {
  return readApi<ObservedOperation>(`/api/operations/${encodeURIComponent(operationId)}`);
}

export async function prepareConversion(operationId: string, owner: string, selectedCreditIds: string[], network: Network): Promise<PreparedStep> {
  return validatePreparedStep(await writeApi<unknown>(`/api/operations/${encodeURIComponent(operationId)}/convert/prepare`, { owner, selectedCreditIds }), { owner, network });
}

export async function prepareRecovery(operationId: string, owner: string, network: Network): Promise<PreparedStep> {
  return validatePreparedStep(await writeApi<unknown>(`/api/operations/${encodeURIComponent(operationId)}/recovery/prepare`, { owner }), { owner, network });
}
