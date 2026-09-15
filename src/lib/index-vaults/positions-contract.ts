import type { DEVNET_TEST_VAULT } from "./devnet-contract.ts";

export interface DevnetVaultPosition {
  identity: typeof DEVNET_TEST_VAULT;
  owner: string;
  shareBalanceRaw: string;
  shareDecimals: number;
  observedSlot: number;
  observedAt: string;
  source: "native-token-accounts";
  navUsd: null;
  valueUsd: null;
}

/** Preserve every share base unit, including balances above Number.MAX_SAFE_INTEGER. */
export function formatVaultShares(raw: string, decimals: number): string {
  if (!/^(0|[1-9][0-9]*)$/.test(raw) || !Number.isInteger(decimals) || decimals < 0 || decimals > 255) throw new Error("Invalid share amount");
  const padded = raw.padStart(decimals + 1, "0");
  const whole = (decimals ? padded.slice(0, -decimals) : padded).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const fraction = decimals ? padded.slice(-decimals).replace(/0+$/, "") : "";
  return fraction ? `${whole}.${fraction}` : whole;
}
