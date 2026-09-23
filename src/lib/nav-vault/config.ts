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

export function navVaultConfig(env: Record<string, string | undefined> = process.env): NavVaultConfig {
  const indexes = parseIndexList(env.STOCKLANA_NAV_VAULT_INDEXES);
  const network = env.STOCKLANA_NAV_VAULT_NETWORK?.trim() || "devnet";
  // Mainnet must be chosen explicitly; anything else is refused rather than guessed.
  if (network !== "devnet" && network !== "mainnet-beta") throw new Error("STOCKLANA_NAV_VAULT_NETWORK must be devnet or mainnet-beta.");
  const programId = env.STOCKLANA_NAV_VAULT_PROGRAM_ID?.trim() ? new PublicKey(env.STOCKLANA_NAV_VAULT_PROGRAM_ID.trim()) : network === "mainnet-beta" ? NAV_VAULT_PROGRAM_ID : NAV_VAULT_DEVNET_PROGRAM_ID;
  const rpcUrl = env.STOCKLANA_NAV_VAULT_RPC_URL?.trim() || (network === "mainnet-beta" ? getHeliusRpcUrl() : NAV_VAULT_DEVNET_RPC);
  return { enabled: indexes.length > 0, indexes, network, programId, rpcUrl };
}

export function navVaultServes(indexId: string, config: NavVaultConfig): boolean {
  return config.enabled && config.indexes.includes(indexId);
}
