import { KAKU_SAN, KAKU_SAN_ASSETS, KAKU_SAN_DEFAULT_SLOTS, KAKU_SAN_DEPLOYER } from "../index-vaults/kaku-san.ts";
import { PREVIEW_MODE } from "./api.ts";

export type KakuSanStep = "create" | "deactivate-default" | "add-token" | "weights";
export interface KakuSanPreparedTx { txBase64: string; messageHash: string; payer: string }
export interface KakuSanPrepared {
  step: KakuSanStep;
  network: "mainnet-beta";
  name: string;
  symbol: string;
  label: string;
  deployer: string;
  hostEntryFeeBps: number;
  hostExitFeeBps: number;
  basket: typeof KAKU_SAN_ASSETS;
  vault: string | null;
  shareMint: string | null;
  mint?: string;
  transactions: KakuSanPreparedTx[];
}
export interface KakuSanSubmitResult {
  step: KakuSanStep;
  vault: string;
  shareMint: string;
  signatures: string[];
  slot: number | null;
}
export interface KakuSanObservation {
  vault: string;
  shareMint: string;
  exists: boolean;
  activeMints: string[];
  inactiveDefaults: string[];
  pythRemaining: boolean;
  weightsSet: boolean;
  verified: boolean;
}
export interface KakuSanReceipt {
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
export type KakuSanNext =
  | { step: "create" }
  | { step: "deactivate-default"; mint: string }
  | { step: "add-token"; mint: string }
  | { step: "weights" }
  | { step: "observe" }
  | { step: "done" };
export interface KakuSanDriftRow {
  ticker: string | null;
  mint: string;
  targetWeightBps: number;
  onchainWeightBps: number | null;
  amountRaw: string;
  driftBps: number | null;
}
export interface KakuSanStatus {
  network: "mainnet-beta";
  name: string;
  symbol: string;
  label: string;
  deployer: string;
  hostEntryFeeBps: number;
  hostExitFeeBps: number;
  nativeTokenCap: number;
  vault: string;
  shareMint: string;
  shareSupplyRaw: string;
  drift: KakuSanDriftRow[];
  eligibility: { required: boolean | null; reason: string };
  keeper: { next: string; intents: { address: string; action: string; type: string }[]; normalRebalanceRequired: boolean | null };
  estimatedOnly: true;
}

export const KAKU_SAN_RECEIPT_KEY = "stocklana.kaku-san.receipt.v1";

type Wallet = {
  mode: "live" | "stub" | "unavailable";
  authenticated: boolean;
  solanaAddress: string | null;
  signTransaction: (transaction: string, network?: "mainnet-beta" | "devnet") => Promise<string>;
};

export function canCreateKakuSan(wallet: Pick<Wallet, "mode" | "authenticated" | "solanaAddress">): boolean {
  return wallet.mode === "live" && wallet.authenticated && wallet.solanaAddress === KAKU_SAN_DEPLOYER;
}

function isAddress(value: unknown): value is string {
  return typeof value === "string" && value.length >= 32 && value.length <= 44;
}

export function parseKakuSanReceipt(value: unknown): KakuSanReceipt | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (!isAddress(input.vault) || !isAddress(input.shareMint)) return null;
  const signatures = Array.isArray(input.signatures) ? input.signatures.filter((row): row is string => typeof row === "string") : [];
  const deactivated = Array.isArray(input.deactivated) ? input.deactivated.filter((row): row is string => typeof row === "string") : [];
  const added = Array.isArray(input.added) ? input.added.filter((row): row is string => typeof row === "string") : [];
  return {
    vault: input.vault, shareMint: input.shareMint, signatures,
    slot: typeof input.slot === "number" ? input.slot : null,
    created: input.created === true,
    deactivated, added,
    weightsSet: input.weightsSet === true,
    verified: input.verified === true,
  };
}

export function loadKakuSanReceipt(): KakuSanReceipt | null {
  try {
    if (typeof localStorage === "undefined") return null;
    const raw = localStorage.getItem(KAKU_SAN_RECEIPT_KEY);
    return raw ? parseKakuSanReceipt(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

export function saveKakuSanReceipt(receipt: KakuSanReceipt): KakuSanReceipt {
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(KAKU_SAN_RECEIPT_KEY, JSON.stringify(receipt));
  } catch { /* private-mode browsers still keep the in-memory receipt */ }
  return receipt;
}

export function clearKakuSanReceipt(): void {
  try {
    if (typeof localStorage !== "undefined") localStorage.removeItem(KAKU_SAN_RECEIPT_KEY);
  } catch { /* private-mode browsers still keep the in-memory receipt */ }
}

export function mergeKakuSanObservation(receipt: KakuSanReceipt, observed: KakuSanObservation): KakuSanReceipt {
  if (observed.vault !== receipt.vault || observed.shareMint !== receipt.shareMint) throw new Error("Will not create a second vault. Resume the saved vault.");
  const deactivated = [...new Set([...receipt.deactivated, ...observed.inactiveDefaults])];
  const added = [...new Set([...receipt.added, ...observed.activeMints.filter(mint => KAKU_SAN_ASSETS.some(asset => asset.mint === mint))])];
  return saveKakuSanReceipt({
    ...receipt,
    created: receipt.created || observed.exists,
    deactivated, added,
    weightsSet: receipt.weightsSet || observed.weightsSet,
    verified: observed.verified,
    slot: receipt.slot,
  });
}

export function nextKakuSanStep(receipt: KakuSanReceipt | null): KakuSanNext {
  if (!receipt?.vault || !receipt.created) return { step: "create" };
  for (const slot of KAKU_SAN_DEFAULT_SLOTS) {
    if (!receipt.deactivated.includes(slot.mint)) return { step: "deactivate-default", mint: slot.mint };
  }
  for (const asset of KAKU_SAN_ASSETS) {
    if (!receipt.added.includes(asset.mint)) return { step: "add-token", mint: asset.mint };
  }
  if (!receipt.weightsSet) return { step: "weights" };
  if (!receipt.verified) return { step: "observe" };
  return { step: "done" };
}

export function applyKakuSanSubmit(receipt: KakuSanReceipt, result: KakuSanSubmitResult, mint?: string): KakuSanReceipt {
  if (result.vault !== receipt.vault || result.shareMint !== receipt.shareMint) throw new Error("Will not create a second vault. Resume the saved vault.");
  const signatures = [...receipt.signatures, ...result.signatures];
  const next: KakuSanReceipt = { ...receipt, signatures, slot: result.slot };
  if (result.step === "create") next.created = true;
  if (result.step === "deactivate-default" && mint && !next.deactivated.includes(mint)) next.deactivated = [...next.deactivated, mint];
  if (result.step === "add-token" && mint && !next.added.includes(mint)) next.added = [...next.added, mint];
  if (result.step === "weights") next.weightsSet = true;
  return saveKakuSanReceipt(next);
}

/** The server journals at most one create draft at a time; if a stale local receipt names a vault the
 * server no longer has journaled (because it was legitimately discarded, never broadcast, elsewhere),
 * the server's freshly prepared draft is the sole current one. Adopt it instead of dead-ending the
 * operator on a receipt the server can neither resume nor discard. */
export function reconcileKakuSanCreateDraft(current: KakuSanReceipt | null, prepared: Pick<KakuSanPrepared, "vault" | "shareMint">): KakuSanReceipt {
  if (!prepared.vault || !prepared.shareMint) throw new Error("Prepare did not return vault and share mint.");
  if (current && current.vault === prepared.vault && current.shareMint === prepared.shareMint) return current;
  return saveKakuSanReceipt({
    vault: prepared.vault, shareMint: prepared.shareMint, signatures: [], slot: null,
    created: false, deactivated: [], added: [], weightsSet: false, verified: false,
  });
}

export async function prepareKakuSan(body: { creator: string; step?: KakuSanStep; vault?: string; shareMint?: string; mint?: string }): Promise<KakuSanPrepared> {
  if (PREVIEW_MODE) throw new Error("UI preview only. No transactions or server-side changes are submitted.");
  const response = await fetch("/api/vaults/kaku-san/prepare", {
    method: "POST", cache: "no-store", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const result = await response.json() as KakuSanPrepared & { error?: string };
  if (!response.ok) throw new Error(result.error ?? "Kaku San prepare unavailable.");
  if (result.network !== KAKU_SAN.network || result.deployer !== KAKU_SAN_DEPLOYER || result.label !== KAKU_SAN.label) throw new Error("Kaku San prepare identity mismatch.");
  if (!Array.isArray(result.transactions) || result.transactions.length === 0) throw new Error("Prepare returned no unsigned transactions.");
  return result;
}

export async function submitKakuSan(body: { creator: string; step: KakuSanStep; vault: string; shareMint: string; signedTransactions: string[] }): Promise<KakuSanSubmitResult> {
  if (PREVIEW_MODE) throw new Error("UI preview only. No transactions or server-side changes are submitted.");
  const response = await fetch("/api/vaults/kaku-san/submit", {
    method: "POST", cache: "no-store", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const result = await response.json() as KakuSanSubmitResult & { error?: string };
  if (!response.ok) throw new Error(result.error ?? "Kaku San submit unavailable.");
  if (!result.vault || !result.shareMint || !result.signatures?.length) throw new Error("Submit did not return vault, share mint and signatures.");
  return result;
}

export async function observeKakuSan(body: { creator: string; vault: string; shareMint: string }): Promise<KakuSanObservation> {
  if (PREVIEW_MODE) throw new Error("UI preview only. No transactions or server-side changes are submitted.");
  const response = await fetch("/api/vaults/kaku-san/observe", {
    method: "POST", cache: "no-store", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const result = await response.json() as KakuSanObservation & { error?: string };
  if (!response.ok) throw new Error(result.error ?? "Kaku San observe unavailable.");
  if (!result.vault || !result.shareMint) throw new Error("Observe did not return vault and share mint.");
  return result;
}

export async function observeKakuSanStatus(body: { creator: string; vault: string; shareMint: string }): Promise<KakuSanStatus> {
  if (PREVIEW_MODE) throw new Error("UI preview only. No transactions or server-side changes are submitted.");
  const response = await fetch("/api/vaults/kaku-san/status", {
    method: "POST", cache: "no-store", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const result = await response.json() as KakuSanStatus & { error?: string };
  if (!response.ok) throw new Error(result.error ?? "Kaku San status unavailable.");
  if (result.network !== KAKU_SAN.network || result.deployer !== KAKU_SAN_DEPLOYER || result.label !== KAKU_SAN.label) throw new Error("Kaku San status identity mismatch.");
  if (result.estimatedOnly !== true) throw new Error("Status must be estimated-only.");
  if (!Array.isArray(result.drift)) throw new Error("Status did not return drift versus target weights.");
  return result;
}

/** Server refuses this once the draft's vault is a real vault on-chain; never discards a created vault. */
export async function discardKakuSan(body: { creator: string; vault: string; shareMint: string }): Promise<{ discarded: boolean }> {
  if (PREVIEW_MODE) throw new Error("UI preview only. No transactions or server-side changes are submitted.");
  const response = await fetch("/api/vaults/kaku-san/discard", {
    method: "POST", cache: "no-store", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const result = await response.json() as { discarded: boolean; error?: string };
  if (!response.ok) throw new Error(result.error ?? "Kaku San discard unavailable.");
  return result;
}

export async function signPreparedKakuSan(prepared: KakuSanPrepared, wallet: Wallet, isCurrent: () => boolean): Promise<string[]> {
  if (!canCreateKakuSan(wallet) || wallet.solanaAddress !== prepared.deployer) throw new Error("Connect the approved deployer wallet.");
  const signed: string[] = [];
  for (const tx of prepared.transactions) {
    if (!isCurrent()) throw new Error("Wallet changed. Nothing was submitted.");
    if (tx.payer !== KAKU_SAN_DEPLOYER) throw new Error("Prepared payer is not the approved deployer.");
    signed.push(await wallet.signTransaction(tx.txBase64, "mainnet-beta"));
  }
  return signed;
}

export { KAKU_SAN, KAKU_SAN_ASSETS, KAKU_SAN_DEFAULT_SLOTS, KAKU_SAN_DEPLOYER };
