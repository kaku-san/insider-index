export type PrivySolanaWalletCandidate = {
  address: string;
  standardWallet: object;
  walletClientType?: unknown;
  connectorType?: unknown;
};

function isPrivyEmbeddedWallet(wallet: PrivySolanaWalletCandidate): boolean {
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

/** Privy's array order is not a user selection. Put external wallets first while retaining
 * embedded wallets as explicitly identified, selectable choices. */
export function selectableSolanaWallets<T extends PrivySolanaWalletCandidate>(wallets: T[]): T[] {
  const external = wallets.filter(wallet => !isPrivyEmbeddedWallet(wallet));
  return [...external, ...wallets.filter(isPrivyEmbeddedWallet)];
}

export function selectedSolanaWallet<T extends PrivySolanaWalletCandidate>(wallets: T[], selectedAddress: string | null): T | null {
  const selectable = selectableSolanaWallets(wallets);
  return selectable.find(wallet => wallet.address === selectedAddress) ?? selectable[0] ?? null;
}
