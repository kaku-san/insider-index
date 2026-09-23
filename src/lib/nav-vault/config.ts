/**
 * NAV vault feature flag (off by default). Server: `STOCKLANA_NAV_VAULT_INDEXES` (comma list of
 * index ids routed to the NAV vault), `STOCKLANA_NAV_VAULT_NETWORK` (devnet only in this branch),
 * `STOCKLANA_NAV_VAULT_PROGRAM_ID`, `STOCKLANA_NAV_VAULT_RPC_URL`. Client:
 * `NEXT_PUBLIC_NAV_VAULT_INDEXES` (same list) switches VaultFlow to the one-signature endpoints.
 */
import { PublicKey } from "@solana/web3.js";
import { NAV_VAULT_PROGRAM_ID } from "./program.ts";

export const NAV_VAULT_DEVNET_RPC = "https://api.devnet.solana.com";
export type NavVaultConfig = { enabled: boolean; indexes: string[]; network: "devnet"; programId: PublicKey; rpcUrl: string };

export function parseIndexList(value: string | undefined): string[] {
  return (value ?? "").split(",").map(item => item.trim()).filter(item => /^[A-Za-z0-9_-]{1,64}$/.test(item));
}

export function navVaultConfig(env: Record<string, string | undefined> = process.env): NavVaultConfig {
  const indexes = parseIndexList(env.STOCKLANA_NAV_VAULT_INDEXES);
  const network = env.STOCKLANA_NAV_VAULT_NETWORK?.trim() || "devnet";
  // No mainnet deployment exists for this unaudited program; refuse rather than guess.
  if (network !== "devnet") throw new Error("The NAV vault is devnet-only on this branch.");
  const programId = env.STOCKLANA_NAV_VAULT_PROGRAM_ID?.trim() ? new PublicKey(env.STOCKLANA_NAV_VAULT_PROGRAM_ID.trim()) : NAV_VAULT_PROGRAM_ID;
  return { enabled: indexes.length > 0, indexes, network: "devnet", programId, rpcUrl: env.STOCKLANA_NAV_VAULT_RPC_URL?.trim() || NAV_VAULT_DEVNET_RPC };
}

export function navVaultServes(indexId: string, config: NavVaultConfig): boolean {
  return config.enabled && config.indexes.includes(indexId);
}
