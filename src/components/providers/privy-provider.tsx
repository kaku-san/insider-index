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

export type PrivySolanaWallet = {
  ready: boolean;
  configured: boolean;
  mode: "live" | "stub" | "unavailable";
  authenticated: boolean;
  solanaAddress: string | null;
  appId: string | null;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  /** Always requires an explicit user signature. Never signs discretionary/unattended trades. */
  signTransaction: (transactionBase64: string) => Promise<string>;
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
  const allowStub = process.env.NODE_ENV !== "production" && PREVIEW_MODE;

  const connect = useCallback(async () => {
    if (pendingLive) {
      throw new Error("Wallet is still connecting.");
    }
    if (!allowStub) throw new Error("Wallet connection is unavailable. Reload to retry Privy.");
    setAuthenticated(true);
  }, [allowStub, pendingLive]);

  const disconnect = useCallback(async () => {
    setAuthenticated(false);
  }, []);

  const signTransaction = useCallback(
    async (transactionBase64: string) => {
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

  const value = useMemo<PrivySolanaWallet>(
    () => ({
      ready: !pendingLive,
      configured: pendingLive,
      mode: pendingLive ? "live" : allowStub ? "stub" : "unavailable",
      authenticated: allowStub && authenticated,
      solanaAddress: allowStub && authenticated ? STUB_WALLET : null,
      appId: null,
      connect,
      disconnect,
      signTransaction,
    }),
    [allowStub, authenticated, connect, disconnect, pendingLive, signTransaction],
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
