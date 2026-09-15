/**
 * Stocklana application contracts, NOT the Symmetry IDL.
 * No transaction sender or native accounting is implemented here.
 * Convert to actual SDK types inside symmetry-adapter.ts only after version pinning.
 */
export type RawAmount = string; // canonical non-negative integer text; validate u64 at token boundary
export type Address = string;   // validate canonical public keys against the actual network
export type Network = "devnet" | "mainnet-beta";
export type Evidence = { observedSlot: number; observedAt: string; source: string; receipt?: string };
export type ConstraintStrength = "native-verified" | "per-swap-only" | "app-policy" | "unverified";

export interface NativeCapabilities {
  network: Network;
  programId: Address;
  sdkVersion: string;
  idlHash: string;
  globalConfigHash: string;
  nativeUsdcExitVerified: boolean;
  nativeUsdcSelection?: { method: string; argumentOrDerivation: string; evidence: Evidence };
  asyncMinNetShares: ConstraintStrength;
  aggregateMinUsdcOut: ConstraintStrength;
  feeVersionBinding: ConstraintStrength;
  claimRecoveryVerified: boolean;
  stageCancellation: Record<string, { permitted: boolean; actor: string; evidence?: Evidence }>;
  evidence: Evidence[];
}
export interface CandidateAsset {
  securityId: string;
  ticker: string;
  provider: "xstocks" | "backpack" | "ondo";
  mint: Address;
  tokenProgram: Address;
  decimals: number;
  targetWeightBps: number;
  priceBasis: "base-token" | "scaled-ui-token" | "underlying-proxy" | "unknown";
  oracle: { kind: string; account: Address; denomination: "USD" | "USDC"; feedId?: string };
  readiness: "READY" | "MARKET_HOURS_ONLY" | "BLOCKED" | "UNTESTED";
  reasons: string[];
  evidence: Evidence[];
}
export interface PolicyValidatedComposition {
  indexId: string;
  personId: string;
  version: number;
  sourceDisclosureHash: string;
  manifestHash: string;
  policyId: string;
  policyHash: string;
  validatedAt: string;
  validatedByService: string;
  decisionEvidenceHash: string;
  assets: CandidateAsset[];
  excludedDisclosedAssets: { securityId: string; reason: string }[];
}
export interface VaultIdentity {
  network: Network;
  programId: Address;
  vaultAccount: Address;
  shareMint: Address;
  shareDecimals: number;
  hostTreasury: Address;
  initialDeployer: Address;
  indexId: string;
  deploymentGeneration: number;
  metadataHash: string;
}
export interface ConstraintDisclosure {
  label: string;
  value: string;
  strength: ConstraintStrength;
  evidence?: Evidence;
}
export interface CostPreview {
  hostEntryFeeBps: number;
  hostExitFeeBps: number;
  globalConfigHash: string;
  otherNativeFees: { name: string; value: string; kind: "flat" | "fee-share" | "other" }[];
  networkBudgetLamports: RawAmount;
  bountyMaxLockedRaw: RawAmount;
  refundableBondRaw: RawAmount;
  quotedSwapCost?: string;
  estimatedOnly: true;
}
export interface UnsignedMessage {
  stepId: string;
  messageBase64: string;
  messageHash: string;
  requiredSigners: Address[];
  allowedProgramIds: Address[];
  maxDebits: { owner: Address; mint: Address; amountRaw: RawAmount }[];
  expectedRecipients: { owner: Address; mint: Address }[];
  recentBlockhash: string;
  lastValidBlockHeight: number;
  simulation: { ok: boolean; slot: number; logsHash: string; error?: string };
}
export interface PreparedStep {
  operationId: string;
  nativeIntent?: Address;
  phase: string; // app state, not a native enum
  requires: "user-signature" | "deployer-signature" | "strategy-service-signature" | "keeper-task" | "wait" | "exception-recovery";
  transactions: UnsignedMessage[];
  configHash: string;
  constraints: ConstraintDisclosure[];
  costs?: CostPreview;
  blockers: string[];
}
export interface NativeClaim {
  owner: Address;
  mint: Address;
  tokenProgram: Address;
  amountRemainingRaw: RawAmount;
  accountExists: boolean;
  transferBlocked: boolean;
}
export interface ConfirmedCredit {
  id: string;
  operationId: string;
  mint: Address;
  recipientOwner: Address;
  tokenProgram: Address;
  creditedRaw: RawAmount;
  soldRaw: RawAmount;
  signature: string;
  instructionIndex: number;
  instructionPath: string; // includes inner-instruction path and credited account identity
  slot: number;
}
export interface ObservedOperation {
  operationId: string;
  identity: VaultIdentity;
  owner: Address;
  kind: "deposit" | "withdraw" | "fund-rebalance";
  nativeIntent?: Address;
  intentGeneration?: { creationSignature: string; firstConfirmedSlot: number };
  phase: string;
  confirmedSharesReceivedRaw?: RawAmount;
  confirmedSharesBurnedRaw?: RawAmount;
  outstandingClaims: NativeClaim[];
  credits: ConfirmedCredit[];
  complete: boolean;
  evidence: Evidence[];
}

/** Transaction construction is separated from signing/sending by design. */
export interface IndexVaultAdapter {
  attest(identity: VaultIdentity): Promise<NativeCapabilities>;
  fetchOperation(operationId: string): Promise<ObservedOperation>;
  prepareDeposit(input: {
    identity: VaultIdentity; owner: Address; amountUsdcRaw: RawAmount;
    operationId: string; expectedConfigHash: string;
  }): Promise<PreparedStep>;
  prepareNextNativeStep(operationId: string): Promise<PreparedStep>;
  prepareWithdrawal(input: {
    identity: VaultIdentity; owner: Address; sharesRaw: RawAmount;
    operationId: string; mode: "in-kind" | "verified-native-usdc";
  }): Promise<PreparedStep>;
  prepareRecovery(operationId: string): Promise<PreparedStep>;
  reconcileSubmittedSignature(operationId: string, signature: string): Promise<ObservedOperation>;
  prepareCompositionUpdate(input: {
    identity: VaultIdentity; manager: Address; composition: PolicyValidatedComposition;
  }): Promise<PreparedStep>;
  prepareEligibleFundRebalance(input: {
    identity: VaultIdentity; keeper: Address; activeVersion: number; nativeEligibilityEvidence: Evidence;
  }): Promise<PreparedStep>;
}

/** Only spends credits attributable to one completed withdrawal, never the whole wallet. */
export interface ExitConversionAdapter {
  prepareRemainingSales(input: {
    operationId: string;
    owner: Address;
    credits: ConfirmedCredit[];
    currentBalances: { mint: Address; raw: RawAmount }[];
  }): Promise<PreparedStep>;
}


/** Creation/name authority is distinct from FMP data and keeper execution. */
export interface DeployerIndexIdentity {
  indexId: string;
  personId: string;
  generation: number;
  name: string;
  symbol: string;
  metadataUri: string;
  metadataSha256: string;
  admittedMints: Address[];
  allowProvisioning: boolean;
  seedUsdcRaw: RawAmount;
  maxSetupLamportsRaw: RawAmount;
  startPrice: string;
  startPriceBasisVerified: boolean;
}
export interface DeployerManifest {
  schemaVersion: 3;
  network: Network;
  deployerPubkey: Address;
  hostTreasuryPubkey: Address;
  strategyManagerPubkey: Address;
  keeperPubkey: Address;
  policyId: string;
  indexes: DeployerIndexIdentity[];
}
export interface DeployerAuthorization {
  manifestHash: string;
  signer: Address;
  domain: "STOCKLANA_DEPLOYER_MANIFEST_V3";
  authorizationEvidence: Evidence;
  expiresAt?: string;
}
export interface NativeProvisioningObservation {
  identity: DeployerIndexIdentity;
  phase: "WAIT_DATA" | "WAIT_READINESS" | "READY_TO_INITIALIZE" |
    "CREATE_PREPARED" | "CREATED_CONFIGURING" | "CONFIG_ACTIVE" |
    "SEEDING" | "VERIFYING" | "READY" | "BLOCKED" | "RECOVERY_REQUIRED";
  nativeVault?: VaultIdentity;
  creationSignature?: string;
  expectedCreator: Address;
  actualCreator?: Address;
  actualHost?: Address;
  outstandingClaims: NativeClaim[];
  blockers: string[];
  evidence: Evidence[];
}
export interface DeployerVaultAdapter {
  prepareInitialize(input: {
    manifest: DeployerManifest;
    indexId: string;
    authorization: DeployerAuthorization;
    composition: PolicyValidatedComposition;
  }): Promise<PreparedStep>;
  resumeConfiguration(indexId: string, generation: number): Promise<PreparedStep>;
  prepareMetadataUpdate(input: {
    identity: VaultIdentity; deployer: Address; name: string; symbol: string;
    metadataUri: string; metadataSha256: string; authorization: DeployerAuthorization;
  }): Promise<PreparedStep>;
  observeProvisioning(indexId: string, generation: number): Promise<NativeProvisioningObservation>;
}

export interface AutomationDecision {
  decision: "NOOP" | "WAIT" | "BLOCKED" | "SUBMIT_WEIGHT_INTENT" | "NATIVE_REBALANCE_ELIGIBLE";
  indexId: string;
  policyHash: string;
  sourceHash: string;
  previousCompositionVersion: number;
  nextCompositionVersion?: number;
  reasons: string[];
  enforcedBy: { rule: string; strength: ConstraintStrength }[];
  evidence: Evidence[];
}
