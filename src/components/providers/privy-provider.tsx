"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

const STUB_WALLET = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";

export type PrivySolanaWallet = {
  ready: boolean;
  configured: boolean;
  mode: "live" | "stub";
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

/** Fixture wallet. Mounted only when NEXT_PUBLIC_PRIVY_APP_ID is missing. */
export function PrivySolanaProvider({ children }: { children: ReactNode }) {
  const [authenticated, setAuthenticated] = useState(false);

  const connect = useCallback(async () => {
    setAuthenticated(true);
  }, []);

  const disconnect = useCallback(async () => {
    setAuthenticated(false);
  }, []);

  const signTransaction = useCallback(
    async (transactionBase64: string) => {
      if (!authenticated) {
        throw new Error("Connect a Solana wallet before signing.");
      }
      if (!transactionBase64) {
        throw new Error("Nothing to sign.");
      }
      return `privy-stub:${STUB_WALLET}:${transactionBase64}`;
    },
    [authenticated],
  );

  const value = useMemo<PrivySolanaWallet>(
    () => ({
      ready: true,
      configured: false,
      mode: "stub",
      authenticated,
      solanaAddress: authenticated ? STUB_WALLET : null,
      appId: null,
      connect,
      disconnect,
      signTransaction,
    }),
    [authenticated, connect, disconnect, signTransaction],
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
