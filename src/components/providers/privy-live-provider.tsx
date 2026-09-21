"use client";

import { PrivyProvider, useLogin, usePrivy } from "@privy-io/react-auth";
import {
  toSolanaWalletConnectors,
  useCreateWallet,
  useSignAndSendTransaction,
  useSignTransaction,
  useSignMessage,
  useWallets,
} from "@privy-io/react-auth/solana";
import { createSolanaRpc, createSolanaRpcSubscriptions } from "@solana/kit";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  PrivySolanaContext,
  type PrivySolanaWallet,
  type WalletConnectMethod,
} from "@/components/providers/privy-provider";
import { selectableSolanaWallets, selectedSolanaWallet, solanaWalletSourceLabel } from "@/lib/frontend/privy-wallet-selection";

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function bytesToBase58(bytes: Uint8Array): string {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  if (!bytes.length) return "";
  const digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let j = 0; j < digits.length; j += 1) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = "";
  for (let i = 0; i < bytes.length - 1 && bytes[i] === 0; i += 1) out += alphabet[0];
  for (let i = digits.length - 1; i >= 0; i -= 1) out += alphabet[digits[i]];
  return out;
}

function encodeSignature(result: unknown): string {
  if (typeof result === "string") return result;
  if (result instanceof Uint8Array) return bytesToBase58(result);
  if (result && typeof result === "object") {
    const record = result as { signature?: Uint8Array | string };
    if (typeof record.signature === "string") return record.signature;
    if (record.signature instanceof Uint8Array) return bytesToBase58(record.signature);
  }
  throw new Error("Privy did not return a Solana transaction signature.");
}

function encodeSignedTransaction(result: unknown): string {
  if (typeof result === "string") {
    return result;
  }
  if (result instanceof Uint8Array) {
    return bytesToBase64(result);
  }
  if (result && typeof result === "object") {
    const record = result as {
      signedTransaction?: Uint8Array | string;
      signature?: string;
    };
    if (typeof record.signedTransaction === "string") {
      return record.signedTransaction;
    }
    if (record.signedTransaction instanceof Uint8Array) {
      return bytesToBase64(record.signedTransaction);
    }
  }
  throw new Error("Privy did not return a signed Solana transaction.");
}

function PrivyLiveBridge({
  appId,
  children,
}: {
  appId: string;
  children: ReactNode;
}) {
  const { ready, authenticated, logout } = usePrivy();
  const { login } = useLogin();
  const { wallets } = useWallets();
  const { createWallet } = useCreateWallet();
  const { signTransaction: signWithPrivy } = useSignTransaction();
  const { signMessage: signMessageWithPrivy } = useSignMessage();
  const { signAndSendTransaction: signAndSendWithPrivy } = useSignAndSendTransaction();
  const [connectionMethod, setConnectionMethod] = useState<WalletConnectMethod | null>(null);
  const [selectedAddress, setSelectedAddress] = useState<string | null>(null);
  // Privy's wallet ordering can put an embedded/email wallet before a connected Phantom. Never
  // bind signing or a public journal to that incidental array position.
  const selectableWallets = useMemo(() => selectableSolanaWallets(wallets), [wallets]);
  const solanaWalletLabels = useMemo(() => Object.fromEntries(selectableWallets.map(candidate => [candidate.address, solanaWalletSourceLabel(candidate)])), [selectableWallets]);
  const wallet = useMemo(() => selectedSolanaWallet(wallets, selectedAddress), [wallets, selectedAddress]);
  useEffect(() => {
    if (selectedAddress && wallets.some(candidate => candidate.address === selectedAddress)) return;
    setSelectedAddress(selectableWallets[0]?.address ?? null);
  }, [selectedAddress, selectableWallets, wallets]);

  const connect = useCallback(async (method: WalletConnectMethod = "wallet") => {
    setConnectionMethod(method);
    if (authenticated) {
      // Creating an embedded wallet is an explicit email choice, never a side effect of merely
      // being authenticated or opening a trading surface.
      if (!wallet && method === "email") await createWallet();
      return;
    }
    await login({ loginMethods: [method === "email" ? "email" : "wallet"], walletChainType: "solana-only" });
  }, [authenticated, createWallet, login, wallet]);

  const disconnect = useCallback(async () => {
    await logout();
    setConnectionMethod(null);
  }, [logout]);

  const signTransaction = useCallback(
    async (transactionBase64: string, network: "mainnet-beta" | "devnet" = "mainnet-beta") => {
      if (!authenticated || !wallet) {
        throw new Error("Connect a Solana wallet before signing.");
      }
      if (!transactionBase64) {
        throw new Error("Nothing to sign.");
      }
      const signed = await signWithPrivy({
        wallet,
        transaction: base64ToBytes(transactionBase64),
        chain: network === "devnet" ? "solana:devnet" : "solana:mainnet",
        options: { uiOptions: { showWalletUIs: true } },
      });
      return encodeSignedTransaction(signed);
    },
    [authenticated, signWithPrivy, wallet],
  );

  const signMessage = useCallback(async (message: string) => {
    if (!authenticated || !wallet || !message) throw new Error("Connect a Solana wallet before authorizing access.");
    const result = await signMessageWithPrivy({ wallet, message: new TextEncoder().encode(message), options: { uiOptions: { showWalletUIs: true } } });
    return bytesToBase58(result.signature);
  }, [authenticated, signMessageWithPrivy, wallet]);

  const signAndSendTransaction = useCallback(
    async (transactionBase64: string, network: "mainnet-beta" | "devnet" = "mainnet-beta") => {
      if (!authenticated || !wallet) {
        throw new Error("Connect a Solana wallet before signing.");
      }
      if (!transactionBase64) {
        throw new Error("Nothing to sign.");
      }
      const sent = await signAndSendWithPrivy({
        wallet,
        transaction: base64ToBytes(transactionBase64),
        chain: network === "devnet" ? "solana:devnet" : "solana:mainnet",
        options: { uiOptions: { showWalletUIs: true } },
      });
      return encodeSignature(sent);
    },
    [authenticated, signAndSendWithPrivy, wallet],
  );

  const value = useMemo<PrivySolanaWallet>(
    () => ({
      ready,
      configured: true,
      mode: "live",
      authenticated,
      previewConnection: false,
      solanaAddress: wallet?.address ?? null,
      solanaWallets: selectableWallets.map(candidate => candidate.address),
      solanaWalletLabels,
      selectSolanaWallet: address => { if (selectableWallets.some(candidate => candidate.address === address)) setSelectedAddress(address); },
      appId,
      connectionMethod: connectionMethod ?? (authenticated ? "wallet" : null),
      connect,
      disconnect,
      signTransaction,
      signMessage,
      signAndSendTransaction,
    }),
    [
      appId,
      authenticated,
      connect,
      connectionMethod,
      disconnect,
      ready,
      signMessage,
      signAndSendTransaction,
      signTransaction,
      wallet?.address,
      selectableWallets,
      solanaWalletLabels,
      wallets,
    ],
  );

  return (
    <PrivySolanaContext.Provider value={value}>
      {children}
    </PrivySolanaContext.Provider>
  );
}

export function PrivyLiveRoot({
  appId,
  children,
}: {
  appId: string;
  children: ReactNode;
}) {
  // Reads/sends go through our /api/rpc proxy so Helius (when configured)
  // serves the wallet without exposing HELIUS_API_KEY to the browser.
  // Subscriptions cannot be proxied through a Next route; use the public
  // websocket unless NEXT_PUBLIC_SOLANA_WS_URL overrides it.
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const http = origin ? `${origin}/api/rpc` : "https://api.mainnet-beta.solana.com";
  const ws = process.env.NEXT_PUBLIC_SOLANA_WS_URL?.trim() || "wss://api.mainnet-beta.solana.com";

  return (
    <PrivyProvider
      appId={appId}
      config={{
        appearance: {
          showWalletLoginFirst: true,
          walletChainType: "solana-only",
        },
        loginMethods: ["wallet", "email"],
        embeddedWallets: {
          solana: {
            createOnLogin: "off",
          },
          ethereum: {
            createOnLogin: "off",
          },
        },
        externalWallets: {
          solana: {
            connectors: toSolanaWalletConnectors(),
          },
        },
        solana: {
          rpcs: {
            "solana:devnet": {
              rpc: createSolanaRpc("https://api.devnet.solana.com"),
              rpcSubscriptions: createSolanaRpcSubscriptions("wss://api.devnet.solana.com"),
            },
            "solana:mainnet": {
              rpc: createSolanaRpc(http),
              rpcSubscriptions: createSolanaRpcSubscriptions(ws),
            },
          },
        },
      }}
    >
      <PrivyLiveBridge appId={appId}>{children}</PrivyLiveBridge>
    </PrivyProvider>
  );
}
