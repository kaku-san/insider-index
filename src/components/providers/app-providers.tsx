"use client";

import dynamic from "next/dynamic";
import type { ReactNode } from "react";
import {
  PrivySolanaProvider,
  readPublicPrivyAppId,
} from "@/components/providers/privy-provider";
import { UIProvider } from "@/components/providers/ui-provider";

const PrivyLiveRoot = dynamic(
  () =>
    import("@/components/providers/privy-live-provider").then(
      (mod) => mod.PrivyLiveRoot,
    ),
  { ssr: false },
);

export function AppProviders({ children }: { children: ReactNode }) {
  const appId = readPublicPrivyAppId();
  if (appId) {
    return (
      <PrivyLiveRoot appId={appId}>
        <UIProvider>{children}</UIProvider>
      </PrivyLiveRoot>
    );
  }
  return (
    <PrivySolanaProvider>
      <UIProvider>{children}</UIProvider>
    </PrivySolanaProvider>
  );
}
