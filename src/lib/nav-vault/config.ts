/**
 * NAV vault feature flag (off by default). Server: `STOCKLANA_NAV_VAULT_INDEXES` (comma list of
 * index ids routed to the NAV vault), `STOCKLANA_NAV_VAULT_NETWORK` (`devnet` default | `mainnet-beta`, explicit),
 * `STOCKLANA_NAV_VAULT_PROGRAM_ID`, `STOCKLANA_NAV_VAULT_RPC_URL`. Client:
 * `NEXT_PUBLIC_NAV_VAULT_INDEXES` (same list) switches VaultFlow to the one-signature endpoints.
 */
import { PublicKey } from "@solana/web3.js";
import { NAV_VAULT_DEVNET_PROGRAM_ID, NAV_VAULT_PROGRAM_ID } from "./program.ts";
import { getHeliusRpcUrl } from "../helius.ts";

export const NAV_VAULT_DEVNET_RPC = "https://api.devnet.solana.com";
export type NavVaultConfig = { enabled: boolean; indexes: string[]; network: "devnet" | "mainnet-beta"; programId: PublicKey; rpcUrl: string };

export function parseIndexList(value: string | undefined): string[] {
  return (value ?? "").split(",").map(item => item.trim()).filter(item => /^[A-Za-z0-9_-]{1,64}$/.test(item));
}

/** Branch preview only: the Vercel PREVIEW deployment of this branch serves Mag7 from the mainnet NAV
 * vault so the captain can do a real $10 invest + cash-out before any production switch. Never
 * active in production (VERCEL_ENV=production) or on the self-hosted site (no VERCEL_ENV). */
export const NAV_VAULT_PREVIEW_BRANCH = "fm/stocklana-nav-vault-f1";
export const NAV_VAULT_PREVIEW_INDEXES = ["idx-theme-mag7-caucus"];
export function navVaultBranchPreview(env: Record<string, string | undefined>): boolean {
  return env.VERCEL_ENV === "preview" && (env.VERCEL_GIT_COMMIT_REF === NAV_VAULT_PREVIEW_BRANCH || Boolean(env.VERCEL_BRANCH_URL?.includes("nav-vault")));
}

export function navVaultConfig(env: Record<string, string | undefined> = process.env): NavVaultConfig {
  const preview = !env.STOCKLANA_NAV_VAULT_INDEXES?.trim() && navVaultBranchPreview(env);
  const indexes = preview ? NAV_VAULT_PREVIEW_INDEXES : parseIndexList(env.STOCKLANA_NAV_VAULT_INDEXES);
  const network = preview ? "mainnet-beta" : env.STOCKLANA_NAV_VAULT_NETWORK?.trim() || "devnet";
  // Mainnet must be chosen explicitly; anything else is refused rather than guessed.
  if (network !== "devnet" && network !== "mainnet-beta") throw new Error("STOCKLANA_NAV_VAULT_NETWORK must be devnet or mainnet-beta.");
  const programId = env.STOCKLANA_NAV_VAULT_PROGRAM_ID?.trim() ? new PublicKey(env.STOCKLANA_NAV_VAULT_PROGRAM_ID.trim()) : network === "mainnet-beta" ? NAV_VAULT_PROGRAM_ID : NAV_VAULT_DEVNET_PROGRAM_ID;
  const rpcUrl = env.STOCKLANA_NAV_VAULT_RPC_URL?.trim() || (network === "mainnet-beta" ? getHeliusRpcUrl() : NAV_VAULT_DEVNET_RPC);
  return { enabled: indexes.length > 0, indexes, network, programId, rpcUrl };
}

export function navVaultServes(indexId: string, config: NavVaultConfig): boolean {
  return config.enabled && config.indexes.includes(indexId);
}
