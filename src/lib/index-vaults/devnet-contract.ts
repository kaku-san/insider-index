import type { PreparedStep } from "./adapter-contract.ts";

/** Public identity from the finalized creation receipt. Never a person/index mapping. */
export const DEVNET_TEST_VAULT = {
  network: "devnet",
  vaultAccount: "Jh7cFNUT5FrtBwKakApsc3Gg5aTQjsZtYxa4dbrCoB8",
  shareMint: "Cdxoni8uv7FrqVfeHJ6YC4DeXs3QQ2uG4nT3BDd9Ny2A",
  usdcMint: "USDCoctVLVnvTXBEuP9s8hntucdJokbo17RwHuNXemT",
  name: "Stocklana Devnet Test",
  shareDecimals: 6,
} as const;

/** No env toggle: a funded receipt alone cannot certify settlement/minima/recovery. */
export const DEVNET_DEPOSIT_SIGNING_ENABLED = false;
export const DEVNET_DEPOSIT_BLOCKERS = [
  "Native settlement, unused returns and claim recovery are not verified.",
  "Independent native instruction decoding, debit budgets and asynchronous share minima are not verified.",
  "Test-vault role/configuration and oracle/route readiness are not approved for app deposits.",
];

export interface DevnetDepositRequest {
  network: "devnet";
  vaultAccount: string;
  shareMint: string;
  amountUsdcRaw: string;
  owner: string | null;
  expectedStateHash?: string;
}
export interface DevnetDepositPreview {
  identity: typeof DEVNET_TEST_VAULT;
  owner: string | null;
  amountUsdcRaw: string;
  observedAt: string;
  observedSlot: number;
  stateHash: string;
  shareSupplyRaw: string;
  shareBalanceRaw: string | null;
  nativeIntent: string | null;
  holdings: { mint: string; amountRaw: string; weightBps: number; active: boolean }[];
  hostEntryFeeBps: number;
  hostExitFeeBps: number;
  estimatedSharesRaw: null;
  prepared: PreparedStep;
}

/** Exact six-decimal display input, without rounding or floating-point multiplication. */
export function devnetUsdcRaw(value: string): string {
  if (!/^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$/.test(value)) throw new Error("Enter a positive USDC amount with at most six decimals.");
  const [whole, fraction = ""] = value.split(".");
  const raw = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
  if (raw <= 0n || raw > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Amount is outside the native SDK's exact range.");
  return raw.toString();
}

export function canSignDevnetDeposit(preview: DevnetDepositPreview | null): boolean {
  return DEVNET_DEPOSIT_SIGNING_ENABLED && !!preview && preview.identity.network === "devnet" &&
    preview.identity.vaultAccount === DEVNET_TEST_VAULT.vaultAccount &&
    preview.identity.shareMint === DEVNET_TEST_VAULT.shareMint &&
    preview.prepared.requires === "user-signature" && preview.prepared.blockers.length === 0 &&
    preview.prepared.transactions.length > 0;
}
