import { SymmetryCore, isRebalanceRequired } from "@symmetry-hq/sdk";
import type { AddOrEditTokenInput, TaskContext, TxPayloadBatchSequence, UIRebalanceIntent, Vault } from "@symmetry-hq/sdk";
import { MINTS, VAULTS_V3_PROGRAM_ID } from "@symmetry-hq/sdk/dist/constants.js";
import { getGlobalConfigPda, getRebalanceIntentPda } from "@symmetry-hq/sdk/dist/instructions/pda.js";
import { Connection, PublicKey } from "@solana/web3.js";
import { getMint, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, unpackAccount } from "@solana/spl-token";
import type { IndexVaultAdapter, NativeCapabilities, Network, ObservedOperation, PreparedStep, VaultIdentity } from "./adapter-contract.ts";
import { address, hashObject, rawAmount, sdkRawAmount, sha256, weightsValid } from "./amounts.ts";
import { feeSnapshot } from "./fees.ts";
import { VAULT_RELEASE } from "./release.ts";
import type { OperationStore } from "./operations.ts";
import type { VaultRegistry } from "./registry.ts";

export const SYMMETRY_SDK_VERSION = "1.0.22";
export const SYMMETRY_PROGRAM_ID = VAULTS_V3_PROGRAM_ID.toBase58();
export const NATIVE_USDC_EXIT_VERIFIED = VAULT_RELEASE.nativeUsdcExitVerified;
export const PUBLIC_FUNDS_ENABLED = VAULT_RELEASE.publicFundsEnabled;
export const GENESIS: Record<Network, string> = { devnet: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG", "mainnet-beta": "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d" };
export const networkUsdc = (network: Network) => MINTS[network === "mainnet-beta" ? "mainnet" : "devnet"].USDC.toBase58();

/** Reject broadcast/airdrop/signing even if accidentally called by an upstream builder. */
export function readOnlyConnection(url: string): Connection {
  return new Connection(url, { commitment: "confirmed", fetchMiddleware: (info, init, next) => {
    const body = JSON.parse(String(init?.body));
    for (const call of Array.isArray(body) ? body : [body]) {
      if (typeof call.method !== "string" || (!call.method.startsWith("get") && !["simulateTransaction", "isBlockhashValid"].includes(call.method))) throw new Error(`Read-only RPC rejects ${call.method}`);
    }
    next(info, init);
  } });
}

/** Exact SDK builders, never a sender. Draft batches are INTERNAL diagnostic artifacts;
 * no public wallet API releases them until independent decoding and native release tests pass.
 */
export class NativeVaultBuilders {
  readonly sdk: SymmetryCore;
  readonly connection: Connection;
  readonly network: Network;
  constructor(connection: Connection, network: Network) {
    this.connection = connection; this.network = network;
    this.sdk = new SymmetryCore({ connection, network: network === "mainnet-beta" ? "mainnet" : "devnet", priorityFee: 25_000 });
  }
  async assertNetwork(): Promise<void> {
    if (await this.connection.getGenesisHash() !== GENESIS[this.network]) throw new Error("RPC genesis/network mismatch");
  }
  async read(identity: VaultIdentity) {
    await this.assertNetwork();
    if (identity.network !== this.network || identity.programId !== SYMMETRY_PROGRAM_ID) throw new Error("Wrong native deployment");
    const key = new PublicKey(address(identity.vaultAccount));
    const account = await this.connection.getAccountInfo(key, "confirmed");
    if (!account || !account.owner.equals(VAULTS_V3_PROGRAM_ID)) throw new Error("Missing/wrong-owner native vault");
    const vault = await this.sdk.fetchVault(identity.vaultAccount);
    if (vault.mint.toBase58() !== identity.shareMint || vault.ownAddress.toBase58() !== identity.vaultAccount || vault.settings.creator.toBase58() !== identity.initialDeployer || vault.settings.host.toBase58() !== identity.hostTreasury) throw new Error("Native vault identity mismatch");
    const mintAccount = await this.connection.getAccountInfo(vault.mint, "confirmed");
    if (!mintAccount) throw new Error("Missing native share mint");
    if (![TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].some(program => mintAccount.owner.equals(program))) throw new Error("Wrong share mint program");
    const mint = await getMint(this.connection, vault.mint, "confirmed", mintAccount.owner);
    if (mint.decimals !== identity.shareDecimals) throw new Error("Native share decimal mismatch");
    return { vault, mint, stateHash: sha256(account.data) };
  }
  async ownerIntent(identity: VaultIdentity, owner: string): Promise<UIRebalanceIntent | null> {
    const intent = getRebalanceIntentPda(new PublicKey(identity.vaultAccount), new PublicKey(address(owner)));
    const account = await this.connection.getAccountInfo(intent, "confirmed");
    if (!account) return null;
    if (!account.owner.equals(VAULTS_V3_PROGRAM_ID)) throw new Error("Wrong intent account owner");
    const decoded = await this.sdk.fetchRebalanceIntent(intent.toBase58());
    if (decoded.chain_data.owner.toBase58() !== owner || decoded.chain_data.vault.toBase58() !== identity.vaultAccount) throw new Error("Wrong native intent owner/vault");
    return decoded;
  }
  async position(identity: VaultIdentity, owner: string) {
    const { vault, mint } = await this.read(identity);
    const accounts = await this.connection.getTokenAccountsByOwner(new PublicKey(address(owner)), { mint: vault.mint }, "confirmed");
    let balance = 0n;
    for (const entry of accounts.value) {
      if (![TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].some(program => entry.account.owner.equals(program))) throw new Error("Wrong share token program");
      const account = unpackAccount(entry.pubkey, entry.account, entry.account.owner);
      if (!account.isInitialized || account.mint.toBase58() !== identity.shareMint || account.owner.toBase58() !== owner) throw new Error("Share token account identity mismatch");
      balance += account.amount;
    }
    return { identity, owner, shareBalanceRaw: balance.toString(), shareDecimals: mint.decimals, observedSlot: accounts.context.slot,
      source: "native-token-accounts" };
  }
  async deposit(identity: VaultIdentity, owner: string, amountUsdcRaw: string): Promise<TxPayloadBatchSequence> {
    rawAmount(amountUsdcRaw, true);
    await this.read(identity);
    if (await this.ownerIntent(identity, owner)) throw new Error("Resume existing native intent");
    // In this distributed build buyVaultTx returns create + deposit; lock is separate (contrary to its doc comment).
    return this.sdk.buyVaultTx({ buyer: owner, vault_mint: identity.shareMint, contributions: [{ mint: networkUsdc(identity.network), amount: sdkRawAmount(amountUsdcRaw) }], rebalance_slippage_bps: 100, per_trade_rebalance_slippage_bps: 50 });
  }
  async withdraw(identity: VaultIdentity, owner: string, sharesRaw: string): Promise<TxPayloadBatchSequence> {
    rawAmount(sharesRaw, true);
    const { vault } = await this.read(identity);
    if (await this.ownerIntent(identity, owner)) throw new Error("Resume existing native intent, never burn twice");
    return this.sdk.sellVaultTx({ seller: owner, vault_mint: identity.shareMint, withdraw_amount: sdkRawAmount(sharesRaw), keep_tokens: completeKeepTokens(vault), rebalance_slippage_bps: 100, per_trade_rebalance_slippage_bps: 50 });
  }
  lock(identity: VaultIdentity, owner: string) { return this.sdk.lockDepositsTx({ buyer: address(owner), vault_mint: identity.shareMint }); }
  addToken(context: TaskContext, token: AddOrEditTokenInput) { return this.sdk.addOrEditTokenTx(context, token); }
  weights(context: TaskContext, assets: { mint: string; targetWeightBps: number }[]) {
    weightsValid(assets);
    return this.sdk.updateWeightsTx(context, { token_weights: assets.map(a => ({ mint: a.mint, weight_bps: a.targetWeightBps })) });
  }
  executeConfiguration(keeper: string, intent: string) { return this.sdk.executeVaultIntentTx({ keeper: address(keeper), intent: address(intent) }); }
  lookupTables(identity: VaultIdentity, deployer: string, accounts: string[]) { return this.sdk.rewriteLookupTablesTx({ signer: address(deployer), vault_mint: identity.shareMint, additional_accounts: accounts.map(address) }); }
  async normalRebalance(identity: VaultIdentity, keeper: string) {
    const { vault } = await this.read(identity);
    if (!await isRebalanceRequired(vault, this.connection)) return null;
    return this.sdk.rebalanceVaultTx({ keeper: address(keeper), vault_mint: identity.shareMint, rebalance_slippage_bps: 100, per_trade_rebalance_slippage_bps: 50 });
  }
  settle(kind: "prices" | "mint" | "redeem" | "cleanup", keeper: string, identity: VaultIdentity, intent: string) {
    const params = { keeper: address(keeper), rebalance_intent: address(intent) };
    if (kind === "prices") return this.sdk.updateTokenPricesTx({ ...params, vault: identity.vaultAccount });
    if (kind === "mint") return this.sdk.mintTx(params);
    if (kind === "redeem") return this.sdk.redeemTokensTx(params);
    return this.sdk.claimBountyTx(params);
  }
  async fees(identity: VaultIdentity) {
    const { vault } = await this.read(identity);
    return { snapshot: feeSnapshot(vault, await this.sdk.fetchGlobalConfig()), pending: await this.sdk.fetchVaultWithdrawVaultFees(identity.vaultAccount) };
  }
  async claimFees(identity: VaultIdentity, claimer: string, remainingFeeAccount?: string) {
    if (claimer !== identity.hostTreasury) throw new Error("Treasury authorization required");
    await this.read(identity);
    if (remainingFeeAccount) {
      const account = await this.sdk.fetchWithdrawVaultFees(remainingFeeAccount);
      if (account.vault.toBase58() !== identity.vaultAccount || !account.owners.some(o => o.toBase58() === claimer)) throw new Error("Fee account attribution mismatch");
      return this.sdk.claimTokenFeesFromVaultTx({ claimer, withdrawVaultFees: remainingFeeAccount });
    }
    return this.sdk.withdrawVaultFeesTx({ claimer, vault: identity.vaultAccount });
  }
}
export function completeKeepTokens(vault: Pick<Vault, "composition" | "numTokens">, residualMints: string[] = []): string[] {
  // numTokens identifies allocated slots, not active-only targets. Every residual remains claimable.
  return [...new Set([...vault.composition.slice(0, vault.numTokens).map(a => a.mint.toBase58()), ...residualMints])].map(address);
}
export function jupiterDirection(pair: { mint_in: string; mint_out: string }) { return { inputMint: pair.mint_out, outputMint: pair.mint_in }; }

/** Application boundary is fail-closed: builders are real, native release evidence is not.
 * No fabricated signatures, holdings, cancellation guarantees or spendable prepared messages.
 */
export class SymmetryVaultAdapter implements IndexVaultAdapter {
  private readonly native: NativeVaultBuilders;
  private readonly registry: VaultRegistry;
  private readonly operations: OperationStore;
  constructor(native: NativeVaultBuilders, registry: VaultRegistry, operations: OperationStore) { this.native = native; this.registry = registry; this.operations = operations; }
  async attest(identity: VaultIdentity): Promise<NativeCapabilities> {
    await this.registry.require(identity, "observe");
    if (await this.native.connection.getGenesisHash() !== GENESIS[identity.network]) throw new Error("RPC genesis/network mismatch");
    const program = await this.native.connection.getAccountInfo(VAULTS_V3_PROGRAM_ID, "confirmed");
    if (!program?.executable) throw new Error("Native program absent/not executable");
    await this.native.read(identity);
    const config = await this.native.connection.getAccountInfo(getGlobalConfigPda(), "confirmed");
    if (!config || !config.owner.equals(VAULTS_V3_PROGRAM_ID)) throw new Error("Native configuration missing");
    return { network: identity.network, programId: SYMMETRY_PROGRAM_ID, sdkVersion: SYMMETRY_SDK_VERSION,
      idlHash: "unavailable:no-standalone-idl-distributed", globalConfigHash: sha256(config.data), nativeUsdcExitVerified: false,
      asyncMinNetShares: "unverified", aggregateMinUsdcOut: "unverified", feeVersionBinding: "unverified", claimRecoveryVerified: false, stageCancellation: {},
      evidence: [{ observedSlot: await this.native.connection.getSlot("confirmed"), observedAt: new Date().toISOString(), source: "RPC confirmed deployment/identity/config read; NOT roundtrip or upgrade-authority attestation" }] };
  }
  async fetchOperation(id: string): Promise<ObservedOperation> { return (await this.operations.get(id)).observed; }
  private wait(id: string, reason: string, configHash = "unverified"): PreparedStep {
    return { operationId: id, phase: "BLOCKED", requires: "wait", transactions: [], configHash,
      constraints: [{ label: "Native asynchronous net-share minimum", value: "Not verified; estimates only", strength: "unverified" }], blockers: [reason, "PUBLIC_FUNDS_DISABLED: no native roundtrip/claim recovery evidence; no broadcasting authorized"] };
  }
  async prepareDeposit(input: Parameters<IndexVaultAdapter["prepareDeposit"]>[0]): Promise<PreparedStep> {
    rawAmount(input.amountUsdcRaw, true); sdkRawAmount(input.amountUsdcRaw); address(input.owner);
    await this.registry.require(input.identity, "observe");
    const capabilities = await this.attest(input.identity);
    if (capabilities.globalConfigHash !== input.expectedConfigHash) return this.wait(input.operationId, "CONFIG_CHANGED", capabilities.globalConfigHash);
    const intent = await this.native.ownerIntent(input.identity, input.owner);
    return this.wait(input.operationId, intent ? "RESUME_EXISTING_NATIVE_INTENT" : "NATIVE_DEPOSIT_DISABLED", capabilities.globalConfigHash);
  }
  async prepareWithdrawal(input: Parameters<IndexVaultAdapter["prepareWithdrawal"]>[0]): Promise<PreparedStep> {
    rawAmount(input.sharesRaw, true); sdkRawAmount(input.sharesRaw); address(input.owner); await this.registry.require(input.identity, "exit");
    return this.wait(input.operationId, input.mode === "verified-native-usdc" ? "NATIVE_USDC_EXIT_DISABLED" : "IN_KIND_CLAIM_RECOVERY_TEST_REQUIRED");
  }
  async prepareNextNativeStep(id: string): Promise<PreparedStep> { await this.operations.get(id); return this.wait(id, "NATIVE_STAGE_FIXTURES_REQUIRED"); }
  async prepareRecovery(id: string): Promise<PreparedStep> { await this.operations.get(id); return this.wait(id, "STAGE_SPECIFIC_RECOVERY_NOT_VERIFIED"); }
  async reconcileSubmittedSignature(id: string, signature: string): Promise<ObservedOperation> {
    const row = await this.operations.get(id);
    const attempt = row.attempts.find(a => a.signature === signature);
    if (!attempt) throw new Error("Unbound signature");
    const tx = await this.native.connection.getTransaction(signature, { commitment: "finalized", maxSupportedTransactionVersion: 0 });
    if (!tx || tx.meta?.err || sha256(tx.transaction.message.serialize()) !== attempt.messageHash) throw new Error("Receipt missing/failed/message mismatch");
    // Finality alone does not prove settlement, amounts, native fee accounting or discharged claims.
    throw new Error("Native effect reconciliation not yet verified; operation retained, never fabricated complete");
  }
  async prepareCompositionUpdate(input: Parameters<IndexVaultAdapter["prepareCompositionUpdate"]>[0]): Promise<PreparedStep> {
    await this.registry.require(input.identity, "observe"); weightsValid(input.composition.assets);
    return this.wait(`weights:${input.identity.indexId}:${input.composition.version}`, "SCOPED_ROLE_AND_NATIVE_ACTIVATION_TEST_REQUIRED", hashObject(input.composition));
  }
  async prepareEligibleFundRebalance(input: Parameters<IndexVaultAdapter["prepareEligibleFundRebalance"]>[0]): Promise<PreparedStep> {
    await this.registry.require(input.identity, "observe");
    return this.wait(`rebalance:${input.identity.indexId}:${input.activeVersion}`, "NORMAL_AUTOMATION_RELEASE_TEST_REQUIRED");
  }
}
