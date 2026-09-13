"use client";

import { Button } from "@/components/ui/button";
import { usePrivySolana } from "@/components/providers/privy-provider";
import { shortenAddress } from "@/lib/format";

export function WalletButton() {
  const wallet = usePrivySolana();

  if (wallet.authenticated && wallet.solanaAddress) {
    return (
      <div className="flex items-center gap-2">
        <span className="hidden font-mono text-xs text-zinc-400 sm:inline">
          {shortenAddress(wallet.solanaAddress, 4)}
        </span>
        <Button variant="outline" size="sm" onClick={() => void wallet.disconnect()}>
          <span className="hidden sm:inline">Disconnect</span>
          <span className="sm:hidden">Exit</span>
        </Button>
      </div>
    );
  }

  return (
    <Button size="sm" onClick={() => void wallet.connect()}>
      <span className="sm:hidden">Connect</span>
      <span className="hidden sm:inline">
        {wallet.configured ? "Connect wallet" : "Connect stub wallet"}
      </span>
    </Button>
  );
}
