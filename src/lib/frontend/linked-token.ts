/** Read-only presentation helpers. Never resolve a token from a ticker or invent a mint. */
export type TokenNetwork = "mainnet-beta" | "devnet" | "testnet";
export type LinkedTokenInput = {
  mint?: string | null;
  network?: string | null;
  issuer?: string | null;
  tokenSymbol?: string | null;
};
const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Base58 public-key shape validation only; this does not prove an on-chain account exists. */
export function isSolanaAddress(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 32 || value.length > 44) return false;
  let n = 0n;
  for (const char of value) {
    const digit = alphabet.indexOf(char);
    if (digit < 0) return false;
    n = n * 58n + BigInt(digit);
  }
  let bytes = 0;
  for (let rest = n; rest > 0n; rest >>= 8n) bytes++;
  let leading = 0;
  while (value[leading] === "1") leading++;
  return bytes + leading === 32;
}
export function tokenNetwork(value?: string | null): TokenNetwork | null {
  return value === "mainnet-beta" || value === "devnet" || value === "testnet" ? value : null;
}
export function shortMint(mint: string): string { return `${mint.slice(0, 6)}…${mint.slice(-6)}`; }
export function issuerLabel(issuer?: string | null): string {
  if (/^xstocks?$/i.test(issuer ?? "")) return "xStocks";
  if (/^backpack(?:\s*\.us)?$/i.test(issuer ?? "")) return "Backpack";
  return "Source-linked token";
}
export function linkedToken(input: LinkedTokenInput) {
  // No trim, substitution or ticker lookup: the copied address must be byte-identical to the source.
  const mint = isSolanaAddress(input.mint) ? input.mint : null;
  const network = tokenNetwork(input.network);
  const query = network && network !== "mainnet-beta" ? `?cluster=${network}` : "";
  return {
    mint, network,
    issuer: issuerLabel(input.issuer),
    symbol: input.tokenSymbol || null,
    networkLabel: network === "mainnet-beta" ? "Solana mainnet" : network ? `Solana ${network}` : "Solana · network not supplied",
    solscan: mint && network ? `https://solscan.io/token/${encodeURIComponent(mint)}${query}` : null,
    explorer: mint && network ? `https://explorer.solana.com/address/${encodeURIComponent(mint)}${query}` : null,
    unavailable: input.mint ? "The source address is not a valid Solana public-key format." : "No token address is supplied for this holding.",
  };
}
