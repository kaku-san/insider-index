import { createSolanaRpc } from "@solana/kit";

const HELIUS_MAINNET = "https://mainnet.helius-rpc.com";

export function getHeliusRpcUrl(): string {
  if (process.env.SOLANA_RPC_URL) return process.env.SOLANA_RPC_URL;
  const apiKey = process.env.HELIUS_API_KEY;
  if (!apiKey) {
    return "https://api.mainnet-beta.solana.com";
  }
  return `${HELIUS_MAINNET}/?api-key=${apiKey}`;
}

export function createHeliusRpc() {
  return createSolanaRpc(getHeliusRpcUrl());
}

export function getRpcProvider(): "rpc" | "helius" | "public" {
  if (process.env.SOLANA_RPC_URL) return "rpc";
  return process.env.HELIUS_API_KEY ? "helius" : "public";
}

/** Legacy name: whether a non-public server RPC is configured. */
export function heliusConfigured(): boolean {
  return getRpcProvider() !== "public";
}
