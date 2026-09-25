"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import { STUB_WALLET_ADDRESS as STUB_WALLET } from "@/lib/wallet";
import { PREVIEW_MODE } from "@/lib/frontend/api";

export type WalletConnectMethod = "wallet";
export type PrivySolanaWallet = {
  ready: boolean;
  configured: boolean;
  mode: "live" | "stub" | "unavailable";
  authenticated: boolean;
  previewConnection: boolean;
  solanaAddress: string | null;
  /** Available live addresses (external wallets only); the selected address is used consistently for header and signing. */
  solanaWallets: string[];
  /** Provenance labels for the listed external wallets. */
  solanaWalletLabels?: Record<string, string>;
  /** True when the session holds only Privy embedded wallets, which are never used for money actions. */
  embeddedOnly?: boolean;
  selectSolanaWallet: (address: string) => void;
  appId: string | null;
  connectionMethod: WalletConnectMethod | null;
  connect: (method?: WalletConnectMethod) => Promise<void>;
  disconnect: () => Promise<void>;
  /** Explicit access-only message signature; fixtures never synthesize authorization. */
  signMessage: (message: string) => Promise<string>;
  /** Always requires an explicit user signature. Never signs discretionary/unattended trades. */
  signTransaction: (transactionBase64: string, network?: "mainnet-beta" | "devnet") => Promise<string>;
  /** Broadcast stays off for fixtures. Live wallets send only user-approved payloads. */
  signAndSendTransaction: (transactionBase64: string, network?: "mainnet-beta" | "devnet") => Promise<string>;
};

export const PrivySolanaContext = createContext<PrivySolanaWallet | null>(null);

export function readPublicPrivyAppId(): string | null {
  const appId =
    process.env.NEXT_PUBLIC_PRIVY_APP_ID?.trim() ||
    process.env.NEXT_PUBLIC_PRIVY_APPID?.trim() ||
    "";
  return appId || null;
}

/** Safe fallback while Privy loads. A fixture is allowed only in an explicit local preview. */
export function PrivySolanaProvider({
  children,
  pendingLive = false,
}: {
  children: ReactNode;
  pendingLive?: boolean;
}) {
  const [authenticated, setAuthenticated] = useState(false);
  const [connectionMethod, setConnectionMethod] = useState<WalletConnectMethod | null>(null);
  const allowStub = process.env.NODE_ENV !== "production" && PREVIEW_MODE;

  const connect = useCallback(async (method: WalletConnectMethod = "wallet") => {
    if (pendingLive) {
      throw new Error("Wallet is still connecting.");
    }
    if (!allowStub) throw new Error("Wallet connection is unavailable. Reload to retry Privy.");
    setConnectionMethod(method);
    setAuthenticated(true);
  }, [allowStub, pendingLive]);

  const disconnect = useCallback(async () => {
    setAuthenticated(false);
    setConnectionMethod(null);
  }, []);

  const signTransaction = useCallback(
    async (transactionBase64: string, network: "mainnet-beta" | "devnet" = "mainnet-beta") => {
      if (network === "devnet") throw new Error("Devnet vault signing requires a live wallet; fixtures are never accepted.");
      if (pendingLive || !allowStub) throw new Error("A live wallet is required to sign.");
      if (!authenticated) {
        throw new Error("Connect a Solana wallet before signing.");
      }
      if (!transactionBase64) {
        throw new Error("Nothing to sign.");
      }
      return `privy-stub:${STUB_WALLET}:${transactionBase64}`;
    },
    [allowStub, authenticated, pendingLive],
  );

  const signAndSendTransaction = useCallback(
    async (_transactionBase64: string, network: "mainnet-beta" | "devnet" = "mainnet-beta") => {
      if (network === "devnet") throw new Error("Devnet vault signing requires a live wallet; fixtures are never accepted.");
      if (pendingLive || !allowStub) throw new Error("A live wallet is required to sign.");
      throw new Error("Fixture wallets cannot broadcast. Connect a live wallet for native index operations.");
    },
    [allowStub, pendingLive],
  );

  const value = useMemo<PrivySolanaWallet>(
    () => ({
      ready: !pendingLive,
      configured: pendingLive,
      mode: pendingLive ? "live" : allowStub ? "stub" : "unavailable",
      authenticated: allowStub && authenticated,
      previewConnection: allowStub && authenticated,
      solanaAddress: allowStub && authenticated ? STUB_WALLET : null,
      solanaWallets: allowStub && authenticated ? [STUB_WALLET] : [],
      solanaWalletLabels: {},
      selectSolanaWallet: () => {},
      appId: null,
      connectionMethod: allowStub && authenticated ? connectionMethod : null,
      connect,
      disconnect,
      signTransaction,
      signMessage: async () => { throw new Error("A live wallet is required for access authorization."); },
      signAndSendTransaction,
    }),
    [allowStub, authenticated, connectionMethod, connect, disconnect, pendingLive, signAndSendTransaction, signTransaction],
  );

  return (
    <PrivySolanaContext.Provider value={value}>
      {children}
    </PrivySolanaContext.Provider>
  );
}

export function usePrivySolana(): PrivySolanaWallet {
  const context = useContext(PrivySolanaContext);
  if (!context) {
    throw new Error("usePrivySolana must be used within PrivySolanaProvider.");
  }
  return context;
}
