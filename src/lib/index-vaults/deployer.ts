import type { DeployerAuthorization, DeployerManifest, DeployerVaultAdapter, NativeProvisioningObservation, PolicyValidatedComposition, PreparedStep } from "./adapter-contract.ts";
import { hashObject, rawAmount } from "./amounts.ts";
import { Journal } from "./journal.ts";
import { verifyManifest, verifyMetadata } from "./registry.ts";
import type { NativeVaultBuilders } from "./symmetry-adapter.ts";
import { weightsValid } from "./amounts.ts";

interface DeploymentDraft { key: string; manifestHash: string; compositionHash: string; vault: string; mint: string; batchHash: string; observation: NativeProvisioningObservation }
export interface DeployerInputs {
  approvedDeployer: string; signatureBase64: string; metadataBytes: Uint8Array;
  /** Per-mint report digest validated independently by readiness.ts, not a client READY flag. */
  readinessHash: string | null;
}
/** Administrative local-only preparation; no investor route, keypair loader or execution option. */
export class ReadOnlyDeployer implements DeployerVaultAdapter {
  private readonly native: NativeVaultBuilders;
  private readonly journal: Journal<{ drafts: DeploymentDraft[] }>;
  private readonly inputs: DeployerInputs;
  constructor(native: NativeVaultBuilders, path: string, inputs: DeployerInputs) { this.native = native; this.inputs = inputs; this.journal = new Journal(path, () => ({ drafts: [] })); }
  async prepareInitialize(input: { manifest: DeployerManifest; indexId: string; authorization: DeployerAuthorization; composition: PolicyValidatedComposition }): Promise<PreparedStep> {
    verifyManifest(input.manifest, input.authorization, this.inputs.signatureBase64, this.inputs.approvedDeployer);
    if (input.manifest.network !== this.native.network) throw new Error("Deployer RPC network mismatch");
    const entry = input.manifest.indexes.find(i => i.indexId === input.indexId);
    if (!entry || !entry.allowProvisioning) throw new Error("Index not deployer-admitted for provisioning");
    verifyMetadata(this.inputs.metadataBytes, entry);
    const c = input.composition;
    weightsValid(c.assets);
    if (c.indexId !== entry.indexId || c.personId !== entry.personId || c.policyId !== input.manifest.policyId || c.manifestHash !== input.authorization.manifestHash || c.assets.some(a => !entry.admittedMints.includes(a.mint))) throw new Error("Composition/manifest admission mismatch");
    const key = `${input.manifest.network}:${entry.indexId}:${entry.generation}`;
    const blockers = ["BROADCAST_DISABLED", "SETUP_COSTS_AND_NATIVE_START_PRICE_BASIS_NOT_VERIFIED", "NATIVE_ROUNDTRIP_NOT_RUN"];
    if (!this.inputs.readinessHash || c.assets.some(a => a.readiness !== "READY")) blockers.push("WAIT_READINESS");
    if (!entry.startPriceBasisVerified) blockers.push("START_PRICE_BASIS_UNVERIFIED");
    rawAmount(entry.seedUsdcRaw); rawAmount(entry.maxSetupLamportsRaw);
    // No draft build without independent native readiness. A hash alone is never execution authorization.
    if (blockers.includes("WAIT_READINESS") || blockers.includes("START_PRICE_BASIS_UNVERIFIED")) return this.step(key, blockers);
    return this.journal.update(async state => {
      const prior = state.drafts.find(d => d.key === key);
      if (prior) {
        if (prior.manifestHash !== input.authorization.manifestHash || prior.compositionHash !== hashObject(c)) throw new Error("Pending deployment conflict: resume original addresses");
        return this.step(key, [...blockers, "CREATE_PREPARED_RESUME_ORIGINAL_ADDRESSES"]);
      }
      await this.native.assertNetwork();
      // SDK discovers mint/vault from native counter; do not guess seeds or regenerate on a timeout.
      const draft = await this.native.sdk.createVaultTx({ creator: input.manifest.deployerPubkey, start_price: entry.startPrice, name: entry.name, symbol: entry.symbol, metadata_uri: entry.metadataUri,
        host_platform_params: { host_pubkey: input.manifest.hostTreasuryPubkey, host_deposit_fee_bps: 25, host_withdraw_fee_bps: 0, host_management_fee_bps: 0, host_performance_fee_bps: 0 } });
      const observation: NativeProvisioningObservation = { identity: entry, phase: "CREATE_PREPARED", expectedCreator: input.manifest.deployerPubkey,
        outstandingClaims: [], blockers: [...blockers, "SHARE_DECIMALS_AND_CREATION_RECEIPT_NOT_OBSERVED"], evidence: [] };
      state.drafts.push({ key, manifestHash: input.authorization.manifestHash, compositionHash: hashObject(c), vault: draft.vault, mint: draft.mint, batchHash: hashObject(draft), observation });
      return this.step(key, observation.blockers);
    });
  }
  private step(id: string, blockers: string[]): PreparedStep { return { operationId: id, phase: "BLOCKED", requires: "wait", transactions: [], configHash: "unverified", constraints: [], blockers }; }
  async resumeConfiguration(indexId: string, generation: number) { const o = await this.observeProvisioning(indexId, generation); return this.step(`${indexId}:${generation}`, o.blockers); }
  async prepareMetadataUpdate(input: Parameters<DeployerVaultAdapter["prepareMetadataUpdate"]>[0]): Promise<PreparedStep> {
    if (input.deployer !== this.inputs.approvedDeployer || input.identity.initialDeployer !== input.deployer) throw new Error("Only deployer may name vaults");
    return this.step(input.identity.indexId, ["METADATA_UPDATE_DISABLED: new signed manifest, native delay and read-back required"]);
  }
  async observeProvisioning(indexId: string, generation: number): Promise<NativeProvisioningObservation> {
    const row = (await this.journal.read()).drafts.find(d => d.key === `${this.native.network}:${indexId}:${generation}`);
    if (!row) throw new Error("No existing deployment draft; do not infer creation from missing account");
    return row.observation;
  }
}
