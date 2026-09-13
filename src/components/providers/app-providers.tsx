"use client";

import type { ReactNode } from "react";
import { PrivySolanaProvider } from "@/components/providers/privy-provider";

export function AppProviders({ children }: { children: ReactNode }) {
  return <PrivySolanaProvider>{children}</PrivySolanaProvider>;
}
