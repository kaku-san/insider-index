import { createPublicKey, verify } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { VAULTS_V3_PROGRAM_ID } from "@symmetry-hq/sdk/dist/constants.js";
import type { DeployerAuthorization, DeployerManifest, VaultIdentity } from "./adapter-contract.ts";
import { address, canonicalJson, hashObject, rawAmount, sha256 } from "./amounts.ts";
import { Journal } from "./journal.ts";

export const MANIFEST_DOMAIN = "STOCKLANA_DEPLOYER_MANIFEST_V3";
export function verifyManifest(manifest: DeployerManifest, authorization: DeployerAuthorization, signatureBase64: string, approvedDeployer: string, now = Date.now()): void {
  if (manifest.schemaVersion !== 3 || !["devnet", "mainnet-beta"].includes(manifest.network)) throw new Error("Unsupported manifest/network");
  const roles = [manifest.deployerPubkey, manifest.hostTreasuryPubkey, manifest.strategyManagerPubkey, manifest.keeperPubkey].map(address);
  if (new Set(roles).size !== 4) throw new Error("Deployer, strategy, treasury and keeper must be separate");
  if (authorization.domain !== MANIFEST_DOMAIN || authorization.signer !== approvedDeployer || manifest.deployerPubkey !== approvedDeployer || authorization.manifestHash !== hashObject(manifest)) throw new Error("Manifest authority/hash mismatch");
  if (authorization.expiresAt && (!Number.isFinite(Date.parse(authorization.expiresAt)) || Date.parse(authorization.expiresAt) <= now)) throw new Error("Manifest authorization expired");
  const key = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), new PublicKey(approvedDeployer).toBuffer()]), format: "der", type: "spki" });
  const message = Buffer.from(`${MANIFEST_DOMAIN}\n${canonicalJson(manifest)}\n${authorization.expiresAt ?? ""}`);
  if (!verify(null, message, key, Buffer.from(signatureBase64, "base64"))) throw new Error("Invalid deployer signature");
  const symbols = new Set<string>(), keys = new Set<string>();
  for (const entry of manifest.indexes) {
    if (!entry.indexId || !entry.personId || !Number.isSafeInteger(entry.generation) || entry.generation < 1) throw new Error("Invalid index identity");
    validateMetadata(entry.name, entry.symbol, entry.metadataUri);
    if (!/^[a-f0-9]{64}$/.test(entry.metadataSha256)) throw new Error("Metadata hash required");
    if (symbols.has(entry.symbol.normalize("NFKC").toUpperCase()) || keys.has(entry.indexId)) throw new Error("Duplicate index identity or symbol within manifest");
    symbols.add(entry.symbol.normalize("NFKC").toUpperCase()); keys.add(entry.indexId);
    entry.admittedMints.forEach(address);
    if (new Set(entry.admittedMints).size !== entry.admittedMints.length) throw new Error("Duplicate admitted mint");
    rawAmount(entry.seedUsdcRaw); rawAmount(entry.maxSetupLamportsRaw);
    if (!/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(entry.startPrice) || Number(entry.startPrice) <= 0 || !Number.isFinite(Number(entry.startPrice))) throw new Error("Invalid start price");
  }
}
export function validateMetadata(name: string, symbol: string, uri: string): void {
  if (!name.trim() || Buffer.byteLength(name) > 32 || !/^[A-Za-z0-9_-]{1,10}$/.test(symbol) || Buffer.byteLength(uri) > 200 || new URL(uri).protocol !== "https:") throw new Error("Invalid native metadata bytes");
}
/** Caller supplies locally read exact bytes; no privileged URL fetch/SSRF surface. */
export function verifyMetadata(bytes: Uint8Array, expected: { name: string; symbol: string; metadataSha256: string }): void {
  if (bytes.length > 65536 || sha256(bytes) !== expected.metadataSha256) throw new Error("Metadata bytes/hash mismatch");
  const json = JSON.parse(Buffer.from(bytes).toString("utf8"));
  if (json.name !== expected.name || json.symbol !== expected.symbol || ![json.description, json.image, json.cover].every(v => typeof v === "string" && v.length > 0)) throw new Error("Metadata content mismatch");
}
export interface RegistryEntry {
  identity: VaultIdentity; name: string; symbol: string; metadataUri: string; manifestHash: string;
  creationSignature: string; phase: "CONFIGURING" | "VERIFYING" | "RETIRED";
  observedSlot: number;
}
export interface RegistryState { entries: RegistryEntry[] }
export class VaultRegistry {
  readonly journal: Journal<RegistryState>;
  constructor(path: string) { this.journal = new Journal(path, () => ({ entries: [] })); }
  async list(indexId?: string): Promise<RegistryEntry[]> { return (await this.journal.read()).entries.filter(e => !indexId || e.identity.indexId === indexId); }
  async register(expected: RegistryEntry, readback: { identity: VaultIdentity; name: string; symbol: string; metadataUri: string; creator: string; host: string }): Promise<void> {
    if (hashObject(expected.identity) !== hashObject(readback.identity) || readback.creator !== expected.identity.initialDeployer || readback.host !== expected.identity.hostTreasury || expected.name !== readback.name || expected.symbol !== readback.symbol || expected.metadataUri !== readback.metadataUri) throw new Error("Native identity/creator/host/metadata mismatch");
    if (expected.identity.programId !== VAULTS_V3_PROGRAM_ID.toBase58() || !["devnet", "mainnet-beta"].includes(expected.identity.network) || !Number.isSafeInteger(expected.identity.deploymentGeneration) || expected.identity.deploymentGeneration < 1 || !Number.isInteger(expected.identity.shareDecimals) || expected.identity.shareDecimals < 0 || expected.identity.shareDecimals > 18) throw new Error("Invalid native deployment identity");
    for (const key of [expected.identity.vaultAccount, expected.identity.shareMint, expected.identity.programId, expected.identity.initialDeployer, expected.identity.hostTreasury]) address(key);
    if (expected.identity.vaultAccount === expected.identity.shareMint || !/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(expected.creationSignature) || expected.observedSlot < 1) throw new Error("Missing native creation evidence");
    await this.journal.update(state => {
      const generation = state.entries.find(e => e.identity.network === expected.identity.network && e.identity.indexId === expected.identity.indexId && e.identity.deploymentGeneration === expected.identity.deploymentGeneration);
      if (generation) { if (hashObject(generation) !== hashObject(expected)) throw new Error("Deployment generation conflict; resume existing vault"); return; }
      if (state.entries.some(e => e.identity.network === expected.identity.network && (e.identity.vaultAccount === expected.identity.vaultAccount || e.identity.shareMint === expected.identity.shareMint || (e.phase !== "RETIRED" && e.symbol.toUpperCase() === expected.symbol.toUpperCase())))) throw new Error("Registry address/symbol collision");
      state.entries.push(expected);
    });
  }
  async require(identity: VaultIdentity, purpose: "entry" | "exit" | "observe"): Promise<RegistryEntry> {
    const entry = (await this.list(identity.indexId)).find(e => hashObject(e.identity) === hashObject(identity));
    if (!entry) throw new Error("Unregistered vault generation");
    if (purpose === "entry") throw new Error("Public funds disabled: native release evidence missing");
    return entry; // Retired generations remain addressable for claims and exits.
  }
}
