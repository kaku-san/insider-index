import { ApiError, PREVIEW_MODE, readApi, writeApi } from "./api";
import { Message, VersionedMessage } from "@solana/web3.js";

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
  simulation: { ok: true; slot: number; logsHash: string; error?: string };
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

export const DEPOSIT_PHASES = [
  "DRAFT","AWAITING_SIGNATURE","SUBMITTED","INTENT_CONFIRMED","AWAITING_LOCK","PRICING","AUCTION","SETTLING","SHARES_RECEIVED","RETURN_PENDING","CLEANUP","COMPLETE"
] as const;
export const WITHDRAW_PHASES = [
  "DRAFT","AWAITING_SIGNATURE","SUBMITTED","REDEMPTION_CLAIM","CLAIM_PENDING","TOKENS_RECEIVED","CONVERTING","COMPLETE_IN_KIND","PARTIAL_USDC","COMPLETE_USDC"
] as const;

export function uiStateFrom(readiness: VaultReadiness | null, position?: IndexSharePosition | null, operation?: ObservedOperation | null): VaultUiState {
  if (operation && !operation.complete) return "PENDING";
  if (position) { try { if (BigInt(position.sharesRaw || "0") > 0n) return "HAS_SHARES"; } catch {} }
  if (!readiness?.identity && !readiness?.vault) return "NO_VAULT";
  if (readiness.depositEnabled || readiness.ready) return "LIVE_DEPOSIT";
  if ((readiness.phase || readiness.status || "").toUpperCase().includes("BLOCK")) return "PREPARE_BLOCKED";
  return "PREVIEW_ONLY";
}

export async function getVaultReadiness(indexId: string): Promise<VaultReadiness | null> {
  if (PREVIEW_MODE) {
    const payload = await readApi<VaultReadiness>(`/api/indexes/${encodeURIComponent(indexId)}/vault`);
    return payload;
  }
  try {
    return await readApi<VaultReadiness>(`/api/indexes/${encodeURIComponent(indexId)}/vault`);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

export async function getIndexPosition(indexId: string, owner: string): Promise<IndexSharePosition | null> {
  try {
    return await readApi<IndexSharePosition>(`/api/indexes/${encodeURIComponent(indexId)}/position?owner=${encodeURIComponent(owner)}`);
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

function decodeBase64(value: string): Uint8Array {
  try {
    const binary = atob(value);
    if (!binary.length || btoa(binary).replace(/=+$/, "") !== value.replace(/=+$/, "")) throw new Error();
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    throw new Error("The prepared transaction bytes are invalid.");
  }
}

function inspectMessage(bytes: Uint8Array): { signers: string[]; programs: string[]; recentBlockhash: string } {
  try {
    const message = bytes[0] !== undefined && (bytes[0] & 0x80) !== 0 ? VersionedMessage.deserialize(bytes) : Message.from(bytes);
    const keys = "staticAccountKeys" in message ? message.staticAccountKeys : message.accountKeys;
    const instructions = "compiledInstructions" in message ? message.compiledInstructions : message.instructions;
    return {
      signers: keys.slice(0, message.header.numRequiredSignatures).map((key) => key.toBase58()),
      programs: [...new Set(instructions.map((instruction) => keys[instruction.programIdIndex]?.toBase58()).filter((value): value is string => Boolean(value)))],
      recentBlockhash: message.recentBlockhash,
    };
  } catch {
    throw new Error("The prepared transaction message is invalid.");
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
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
  if (blockers.length) throw new Error("The prepared step is blocked.");
  if (!transactions.length) throw new Error("No signable transactions were returned.");

  for (const candidate of transactions) {
    const transaction = record(candidate);
    string(transaction.stepId, "step ID");
    const bytes = decodeBase64(string(transaction.messageBase64, "transaction"));
    const inspected = inspectMessage(bytes);
    const messageHash = string(transaction.messageHash, "message hash").toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(messageHash) || await sha256Hex(bytes) !== messageHash) throw new Error("The prepared transaction hash does not match its bytes.");
    const signers = array(transaction.requiredSigners, "required signers").map((value) => addressValue(value, "required signer"));
    if (!signers.includes(owner) || signers.length !== inspected.signers.length || signers.some((signer) => !inspected.signers.includes(signer))) throw new Error("The prepared transaction is not bound to its declared signers.");
    const programs = array(transaction.allowedProgramIds, "allowed programs").map((value) => addressValue(value, "allowed program"));
    if (!programs.length || new Set(programs).size !== programs.length || programs.length !== inspected.programs.length || programs.some((program) => !inspected.programs.includes(program))) throw new Error("The prepared allowed programs do not match the transaction.");
    for (const value of array(transaction.maxDebits, "maximum debits")) {
      const debit = record(value);
      if (addressValue(debit.owner, "debit owner") !== owner) throw new Error("A prepared debit is not bound to the connected wallet.");
      addressValue(debit.mint, "debit mint");
      if (typeof debit.amountRaw !== "string" || !rawAmountPattern.test(debit.amountRaw)) throw new Error("A prepared debit amount is invalid.");
    }
    for (const value of array(transaction.expectedRecipients, "expected recipients")) {
      const recipient = record(value);
      addressValue(recipient.owner, "recipient owner");
      addressValue(recipient.mint, "recipient mint");
    }
    if (string(transaction.recentBlockhash, "recent blockhash") !== inspected.recentBlockhash) throw new Error("The prepared transaction blockhash does not match its bytes.");
    if (!Number.isSafeInteger(transaction.lastValidBlockHeight) || Number(transaction.lastValidBlockHeight) <= 0) throw new Error("The prepared transaction expiry is invalid.");
    const simulation = record(transaction.simulation);
    if (simulation.ok !== true || !Number.isSafeInteger(simulation.slot) || Number(simulation.slot) <= 0 || !string(simulation.logsHash, "simulation log hash")) throw new Error("The prepared transaction simulation did not pass.");
  }

  return { ...(payload as Omit<PreparedStep, "network">), network: context.network };
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
