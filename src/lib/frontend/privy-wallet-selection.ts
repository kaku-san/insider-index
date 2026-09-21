export type PrivySolanaWalletCandidate = { address: string; standardWallet: object };

function isPrivyEmbeddedWallet(wallet: PrivySolanaWalletCandidate): boolean {
  return (wallet.standardWallet as { isPrivyWallet?: unknown }).isPrivyWallet === true;
}

/** Privy's array order is not a user selection. Prefer an external standard wallet; otherwise
 * retain the address explicitly selected in the wallet sheet. */
export function selectableSolanaWallets<T extends PrivySolanaWalletCandidate>(wallets: T[]): T[] {
  const external = wallets.filter(wallet => !isPrivyEmbeddedWallet(wallet));
  return external.length ? external : wallets;
}

export function selectedSolanaWallet<T extends PrivySolanaWalletCandidate>(wallets: T[], selectedAddress: string | null): T | null {
  const selectable = selectableSolanaWallets(wallets);
  return selectable.find(wallet => wallet.address === selectedAddress) ?? selectable[0] ?? null;
}
