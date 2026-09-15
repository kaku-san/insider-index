import { KAKU_SAN, KAKU_SAN_ASSETS, KAKU_SAN_DEPLOYER } from "../index-vaults/kaku-san.ts";
import { PREVIEW_MODE } from "./api.ts";

export type KakuSanStep = "create" | "add-token" | "weights" | "prices" | "rebalance";
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
  eligible?: boolean;
  reason?: string;
  keeperNext?: string;
}
export interface KakuSanSubmitResult {
  step: KakuSanStep;
  vault: string;
  shareMint: string;
  signatures: string[];
  slot: number | null;
}
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

type Wallet = {
  mode: "live" | "stub" | "unavailable";
  authenticated: boolean;
  solanaAddress: string | null;
  signTransaction: (transaction: string, network?: "mainnet-beta" | "devnet") => Promise<string>;
};

export function canCreateKakuSan(wallet: Pick<Wallet, "mode" | "authenticated" | "solanaAddress">): boolean {
  return wallet.mode === "live" && wallet.authenticated && wallet.solanaAddress === KAKU_SAN_DEPLOYER;
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

export async function observeKakuSan(body: { creator: string; vault: string; shareMint: string }): Promise<KakuSanStatus> {
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

export async function prepareKakuSanKeeper(body: { creator: string; step: "prices" | "rebalance"; vault: string; shareMint: string }): Promise<KakuSanPrepared> {
  if (PREVIEW_MODE) throw new Error("UI preview only. No transactions or server-side changes are submitted.");
  const response = await fetch("/api/vaults/kaku-san/prepare", {
    method: "POST", cache: "no-store", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const result = await response.json() as KakuSanPrepared & { error?: string };
  if (!response.ok) throw new Error(result.error ?? "Kaku San keeper prepare unavailable.");
  if (result.network !== KAKU_SAN.network || result.deployer !== KAKU_SAN_DEPLOYER || result.label !== KAKU_SAN.label) throw new Error("Kaku San prepare identity mismatch.");
  if (!Array.isArray(result.transactions)) throw new Error("Prepare returned no transaction list.");
  if (body.step === "rebalance" && result.eligible === false) return result;
  if (result.transactions.length === 0) throw new Error("Prepare returned no unsigned transactions.");
  return result;
}

export { KAKU_SAN, KAKU_SAN_ASSETS, KAKU_SAN_DEPLOYER };
