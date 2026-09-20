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
  };
  depositsEnabled?: boolean;
  depositReason?: string | null;
  publicFundsEnabled?: boolean;
};

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
  return {
    indexId,
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

/** Public Live/Invest: created vault + per-index deposit gate. Signing still uses `depositIsEnabled`. */
export function publicIndexIsLive(state: PublicVaultDepositState): boolean {
  return hasPublicVaultIdentity(state) && state.depositsEnabled === true;
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

export async function validatePreparedStep(payload: unknown, context: { owner: string; network: Network }): Promise<PreparedStep> {
  addressValue(context.owner, "wallet owner");
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
  throw new Error("Native vault signing is unavailable until transaction instructions can be verified against declared debits and recipients.");
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
