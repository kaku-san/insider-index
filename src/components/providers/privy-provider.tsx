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
  authenticated: boolean;
  solanaAddress: string | null;
  appId: string | null;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  signTransaction: (transactionBase64: string) => Promise<string>;
};

const PrivySolanaContext = createContext<PrivySolanaWallet | null>(null);

function readPublicAppId(): string | null {
  return (
    process.env.NEXT_PUBLIC_PRIVY_APP_ID ??
    process.env.NEXT_PUBLIC_PRIVY_APPID ??
    null
  );
}

export function PrivySolanaProvider({ children }: { children: ReactNode }) {
  const appId = readPublicAppId();
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
      return `privy-stub:${STUB_WALLET}:${transactionBase64}`;
    },
    [authenticated],
  );

  const value = useMemo<PrivySolanaWallet>(
    () => ({
      ready: true,
      configured: Boolean(appId),
      authenticated,
      solanaAddress: authenticated ? STUB_WALLET : null,
      appId,
      connect,
      disconnect,
      signTransaction,
    }),
    [appId, authenticated, connect, disconnect, signTransaction],
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
