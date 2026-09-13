import { createSolanaRpc } from "@solana/kit";

const HELIUS_MAINNET = "https://mainnet.helius-rpc.com";

export function getHeliusRpcUrl(): string {
  const apiKey = process.env.HELIUS_API_KEY;
  if (!apiKey) {
    return "https://api.mainnet-beta.solana.com";
  }
  return `${HELIUS_MAINNET}/?api-key=${apiKey}`;
}

export function createHeliusRpc() {
  return createSolanaRpc(getHeliusRpcUrl());
}

export function heliusConfigured(): boolean {
  return Boolean(process.env.HELIUS_API_KEY);
}
