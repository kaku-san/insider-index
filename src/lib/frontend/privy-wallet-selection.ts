export type PrivySolanaWalletCandidate = {
  address: string;
  standardWallet: object;
  walletClientType?: unknown;
  connectorType?: unknown;
};

/** InsiderIndex signs and settles money only with a wallet the user controls outside Privy. */
export const EXTERNAL_WALLET_REQUIRED = "Connect an external Solana wallet (Phantom, Solflare or another compatible wallet) to invest, cash out or claim.";

export function isPrivyEmbeddedWallet(wallet: PrivySolanaWalletCandidate): boolean {
  return (wallet.standardWallet as { isPrivyWallet?: unknown }).isPrivyWallet === true;
}

/** Identify wallet provenance without relying on Privy's incidental array order. */
export function solanaWalletSourceLabel(wallet: PrivySolanaWalletCandidate): string {
  if (isPrivyEmbeddedWallet(wallet)) return "Privy embedded";
  const standardWallet = wallet.standardWallet as { name?: unknown; walletClientType?: unknown; connectorType?: unknown };
  const client = [wallet.walletClientType, standardWallet.walletClientType, standardWallet.name, wallet.connectorType, standardWallet.connectorType]
    .find((value): value is string => typeof value === "string" && value.trim().length > 0);
  if (!client) return "External wallet";
  const name = client.trim().replace(/[-_]+/g, " ").replace(/\b\w/g, character => character.toUpperCase());
  return `${name}/external`;
}

/** External Solana wallets only. Privy's array order is not a user selection, and a Privy embedded
 * wallet is never offered for signing, invest or cash-out: a legacy embedded-only session is refused
 * with {@link EXTERNAL_WALLET_REQUIRED} instead. */
export function selectableSolanaWallets<T extends PrivySolanaWalletCandidate>(wallets: T[]): T[] {
  return wallets.filter(wallet => !isPrivyEmbeddedWallet(wallet));
}

export function selectedSolanaWallet<T extends PrivySolanaWalletCandidate>(wallets: T[], selectedAddress: string | null): T | null {
  const selectable = selectableSolanaWallets(wallets);
  return selectable.find(wallet => wallet.address === selectedAddress) ?? selectable[0] ?? null;
}

/** True when the session is authenticated but every Privy wallet it holds is an embedded one. */
export function hasEmbeddedOnlySession(wallets: readonly PrivySolanaWalletCandidate[]): boolean {
  return wallets.length > 0 && selectableSolanaWallets([...wallets]).length === 0;
}
