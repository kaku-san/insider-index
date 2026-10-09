import { createSolanaRpc } from "@solana/kit";

const HELIUS_MAINNET = "https://mainnet.helius-rpc.com";
const PUBLIC_MAINNET = "https://api.mainnet-beta.solana.com";

function rpcConfiguration(): { url: string; provider: "rpc" | "helius" | "public" } {
  const rpcUrl = process.env.SOLANA_RPC_URL?.trim();
  if (rpcUrl) return { url: rpcUrl, provider: "rpc" };

  const apiKey = process.env.HELIUS_API_KEY?.trim();
  if (apiKey) return { url: `${HELIUS_MAINNET}/?api-key=${apiKey}`, provider: "helius" };

  return { url: PUBLIC_MAINNET, provider: "public" };
}

export function getHeliusRpcUrl(): string {
  return rpcConfiguration().url;
}

export function createHeliusRpc() {
  return createSolanaRpc(getHeliusRpcUrl());
}

export function getRpcProvider(): "rpc" | "helius" | "public" {
  return rpcConfiguration().provider;
}

export function rpcConfigured(): boolean {
  return getRpcProvider() !== "public";
}

export function heliusConfigured(): boolean {
  return Boolean(process.env.HELIUS_API_KEY?.trim());
}
