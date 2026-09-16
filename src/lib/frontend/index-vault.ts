/**
 * Client for the general InsiderIndex vault-create admin flow (any persisted definition).
 *
 * Unlike the fixed Kaku San client (`kaku-san.ts`), the legs, weights and pools are read live from
 * the server preview (one source of truth: the persisted definition), never from constants. Every
 * signed action still goes through the same approved-deployer wallet; the server enforces the real
 * Ed25519 signature and never holds a key.
 */
import { KAKU_SAN_DEFAULT_SLOTS, KAKU_SAN_DEPLOYER } from "../index-vaults/kaku-san.ts";
import { PREVIEW_MODE } from "./api.ts";

export type IndexCreateStep = "create" | "deactivate-default" | "add-token" | "weights";
export interface IndexPreparedTx { txBase64: string; messageHash: string; payer: string }
export interface IndexCreatableLeg {
  ticker: string;
  mint: string;
  decimals: number;
  pool: string;
  kind: "raydium_clmm" | "raydium_cpmm";
  targetWeightBps: number;
  tvlUsd: number | null;
}
export interface IndexPrepared {
  step: IndexCreateStep;
  indexId: string;
  network: "mainnet-beta";
  name: string;
  symbol: string;
  deployer: string;
  hostEntryFeeBps: number;
  hostExitFeeBps: number;
  legs: IndexCreatableLeg[];
  vault: string | null;
  shareMint: string | null;
  mint?: string;
  transactions: IndexPreparedTx[];
}
export interface IndexSubmitResult {
  step: IndexCreateStep;
  indexId: string;
  vault: string;
  shareMint: string;
  signatures: string[];
  slot: number | null;
  writtenBack: boolean;
}
export interface IndexObservation {
  indexId: string;
  vault: string;
  shareMint: string;
  exists: boolean;
  activeMints: string[];
  inactiveDefaults: string[];
  pythRemaining: boolean;
  weightsSet: boolean;
  verified: boolean;
}
export interface IndexPreviewCoverage {
  tickerCount: number;
  mappedLegCount: number;
  vaultReadyLegCount: number;
  mappableByWeightBps: number;
  unmappedByWeightBps: number;
  poolReadyOfMappedBps: number;
}
export interface IndexPreview {
  indexId: string;
  name: string;
  symbol: string;
  network: string;
  kind: string;
  status: string;
  creatable: boolean;
  refuseReason: string | null;
  depositsEnabled: boolean;
  depositReason: string | null;
  deployer: string;
  hostEntryFeeBps: number;
  hostExitFeeBps: number;
  nativeTokenCap: number;
  legCount: number;
  legs: IndexCreatableLeg[];
  coverage: IndexPreviewCoverage;
  poolExcludedLegs: { ticker: string; mint: string; reason: string }[];
  vaultAddress: string | null;
  shareMint: string | null;
  bookSource: string | null;
}
export interface IndexSummary {
  indexId: string;
  name: string;
  symbol: string;
  status: string;
  structurallyCreatable: boolean;
  coverage: Record<string, unknown>;
  vaultAddress: string | null;
  shareMint: string | null;
}
export interface IndexReceipt {
  indexId: string;
  vault: string;
  shareMint: string;
  signatures: string[];
  slot: number | null;
  created: boolean;
  deactivated: string[];
  added: string[];
  weightsSet: boolean;
  verified: boolean;
}
export type IndexNext =
  | { step: "create" }
  | { step: "deactivate-default"; mint: string }
  | { step: "add-token"; mint: string }
  | { step: "weights" }
  | { step: "observe" }
  | { step: "done" };

export const INDEX_RECEIPT_PREFIX = "stocklana.index-vault.receipt.v1.";
const DEFAULT_SLOT_MINTS = KAKU_SAN_DEFAULT_SLOTS.map(slot => slot.mint);

type Wallet = {
  mode: "live" | "stub" | "unavailable";
  authenticated: boolean;
  solanaAddress: string | null;
  signTransaction: (transaction: string, network?: "mainnet-beta" | "devnet") => Promise<string>;
};

export function canCreateIndexVault(wallet: Pick<Wallet, "mode" | "authenticated" | "solanaAddress">): boolean {
  return wallet.mode === "live" && wallet.authenticated && wallet.solanaAddress === KAKU_SAN_DEPLOYER;
}

function isAddress(value: unknown): value is string {
  return typeof value === "string" && value.length >= 32 && value.length <= 44;
}

export function parseIndexReceipt(value: unknown): IndexReceipt | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (typeof input.indexId !== "string" || !isAddress(input.vault) || !isAddress(input.shareMint)) return null;
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((row): row is string => typeof row === "string") : []);
  return {
    indexId: input.indexId, vault: input.vault, shareMint: input.shareMint,
    signatures: strings(input.signatures),
    slot: typeof input.slot === "number" ? input.slot : null,
    created: input.created === true,
    deactivated: strings(input.deactivated), added: strings(input.added),
    weightsSet: input.weightsSet === true,
    verified: input.verified === true,
  };
}

function receiptKey(indexId: string): string {
  return `${INDEX_RECEIPT_PREFIX}${indexId}`;
}
export function loadIndexReceipt(indexId: string): IndexReceipt | null {
  try {
    if (typeof localStorage === "undefined") return null;
    const raw = localStorage.getItem(receiptKey(indexId));
    return raw ? parseIndexReceipt(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}
export function saveIndexReceipt(receipt: IndexReceipt): IndexReceipt {
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(receiptKey(receipt.indexId), JSON.stringify(receipt));
  } catch { /* private-mode browsers keep the in-memory receipt */ }
  return receipt;
}
export function clearIndexReceipt(indexId: string): void {
  try {
    if (typeof localStorage !== "undefined") localStorage.removeItem(receiptKey(indexId));
  } catch { /* private-mode browsers keep the in-memory receipt */ }
}

export function nextIndexStep(receipt: IndexReceipt | null, legMints: readonly string[]): IndexNext {
  if (!receipt?.vault || !receipt.created) return { step: "create" };
  for (const mint of DEFAULT_SLOT_MINTS) {
    if (!receipt.deactivated.includes(mint)) return { step: "deactivate-default", mint };
  }
  for (const mint of legMints) {
    if (!receipt.added.includes(mint)) return { step: "add-token", mint };
  }
  if (!receipt.weightsSet) return { step: "weights" };
  if (!receipt.verified) return { step: "observe" };
  return { step: "done" };
}

export function mergeIndexObservation(receipt: IndexReceipt, observed: IndexObservation, legMints: readonly string[]): IndexReceipt {
  if (observed.indexId !== receipt.indexId || observed.vault !== receipt.vault || observed.shareMint !== receipt.shareMint) {
    throw new Error("Will not create a second vault. Resume the saved vault.");
  }
  const deactivated = [...new Set([...receipt.deactivated, ...observed.inactiveDefaults])];
  const added = [...new Set([...receipt.added, ...observed.activeMints.filter(mint => legMints.includes(mint))])];
  return saveIndexReceipt({
    ...receipt,
    created: receipt.created || observed.exists,
    deactivated, added,
    weightsSet: receipt.weightsSet || observed.weightsSet,
    verified: observed.verified,
    slot: receipt.slot,
  });
}

export function applyIndexSubmit(receipt: IndexReceipt, result: IndexSubmitResult, mint?: string): IndexReceipt {
  if (result.indexId !== receipt.indexId || result.vault !== receipt.vault || result.shareMint !== receipt.shareMint) {
    throw new Error("Will not create a second vault. Resume the saved vault.");
  }
  const signatures = [...receipt.signatures, ...result.signatures];
  const next: IndexReceipt = { ...receipt, signatures, slot: result.slot };
  if (result.step === "create") next.created = true;
  if (result.step === "deactivate-default" && mint && !next.deactivated.includes(mint)) next.deactivated = [...next.deactivated, mint];
  if (result.step === "add-token" && mint && !next.added.includes(mint)) next.added = [...next.added, mint];
  if (result.step === "weights") next.weightsSet = true;
  return saveIndexReceipt(next);
}

export function reconcileIndexCreateDraft(current: IndexReceipt | null, prepared: Pick<IndexPrepared, "indexId" | "vault" | "shareMint">): IndexReceipt {
  if (!prepared.vault || !prepared.shareMint) throw new Error("Prepare did not return vault and share mint.");
  if (current && current.indexId === prepared.indexId && current.vault === prepared.vault && current.shareMint === prepared.shareMint) return current;
  return saveIndexReceipt({
    indexId: prepared.indexId, vault: prepared.vault, shareMint: prepared.shareMint, signatures: [], slot: null,
    created: false, deactivated: [], added: [], weightsSet: false, verified: false,
  });
}

async function postJson<T>(path: string, body: unknown, fallback: string): Promise<T> {
  if (PREVIEW_MODE) throw new Error("UI preview only. No transactions or server-side changes are submitted.");
  const response = await fetch(path, {
    method: "POST", cache: "no-store", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const result = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(result.error ?? fallback);
  return result;
}

export async function listIndexDefinitions(body: { creator: string }): Promise<IndexSummary[]> {
  const result = await postJson<{ definitions: IndexSummary[] }>("/api/vaults/index/list", body, "Index list unavailable.");
  if (!Array.isArray(result.definitions)) throw new Error("List did not return definitions.");
  return result.definitions;
}

export async function previewIndexDefinition(body: { creator: string; indexId: string }): Promise<IndexPreview> {
  const result = await postJson<IndexPreview>("/api/vaults/index/preview", body, "Index preview unavailable.");
  if (result.indexId !== body.indexId || result.deployer !== KAKU_SAN_DEPLOYER) throw new Error("Index preview identity mismatch.");
  return result;
}

export async function prepareIndex(body: { creator: string; indexId: string; step?: IndexCreateStep; vault?: string; shareMint?: string; mint?: string }): Promise<IndexPrepared> {
  const result = await postJson<IndexPrepared>("/api/vaults/index/prepare", body, "Index prepare unavailable.");
  if (result.network !== "mainnet-beta" || result.deployer !== KAKU_SAN_DEPLOYER || result.indexId !== body.indexId) throw new Error("Index prepare identity mismatch.");
  if (!Array.isArray(result.transactions) || result.transactions.length === 0) throw new Error("Prepare returned no unsigned transactions.");
  return result;
}

export async function submitIndex(body: { creator: string; indexId: string; step: IndexCreateStep; vault: string; shareMint: string; signedTransactions: string[] }): Promise<IndexSubmitResult> {
  const result = await postJson<IndexSubmitResult>("/api/vaults/index/submit", body, "Index submit unavailable.");
  if (!result.vault || !result.shareMint || !result.signatures?.length) throw new Error("Submit did not return vault, share mint and signatures.");
  return result;
}

export async function observeIndex(body: { creator: string; indexId: string; vault: string; shareMint: string }): Promise<IndexObservation> {
  const result = await postJson<IndexObservation>("/api/vaults/index/observe", body, "Index observe unavailable.");
  if (!result.vault || !result.shareMint) throw new Error("Observe did not return vault and share mint.");
  return result;
}

export async function discardIndex(body: { creator: string; indexId: string; vault: string; shareMint: string; signedTransaction: string }): Promise<{ discarded: boolean }> {
  return postJson<{ discarded: boolean }>("/api/vaults/index/discard", body, "Index discard unavailable.");
}

export async function signPreparedIndex(prepared: IndexPrepared, wallet: Wallet, isCurrent: () => boolean): Promise<string[]> {
  if (!canCreateIndexVault(wallet) || wallet.solanaAddress !== prepared.deployer) throw new Error("Connect the approved deployer wallet.");
  const signed: string[] = [];
  for (const tx of prepared.transactions) {
    if (!isCurrent()) throw new Error("Wallet changed. Nothing was submitted.");
    if (tx.payer !== KAKU_SAN_DEPLOYER) throw new Error("Prepared payer is not the approved deployer.");
    signed.push(await wallet.signTransaction(tx.txBase64, "mainnet-beta"));
  }
  return signed;
}

export { KAKU_SAN_DEPLOYER, KAKU_SAN_DEFAULT_SLOTS };
