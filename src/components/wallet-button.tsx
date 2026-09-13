"use client";

import { Button } from "@/components/ui/button";
import { usePrivySolana } from "@/components/providers/privy-provider";
import { useUI } from "@/components/providers/ui-provider";
import { Icon } from "@/components/social/icon";
import { PREVIEW_MODE } from "@/lib/frontend/api";
import { shortenAddress } from "@/lib/format";

export function WalletButton() {
  const wallet = usePrivySolana();
  const ui = useUI();
  const label =
    !wallet.ready
      ? "Connecting…"
      : wallet.authenticated && wallet.solanaAddress
        ? shortenAddress(wallet.solanaAddress)
        : PREVIEW_MODE
          ? "Preview wallet"
          : "Connect wallet";

  return (
    <Button
      className="button primary wallet-button"
      disabled={!wallet.ready}
      onClick={() =>
        void (wallet.authenticated ? wallet.disconnect() : wallet.connect()).catch(
          () => ui.toast("Wallet connection failed. Please retry."),
        )
      }
      title={
        wallet.mode === "live"
          ? "Connect a Privy Solana wallet. You sign every trade."
          : "The included wallet is a stub until NEXT_PUBLIC_PRIVY_APP_ID is set."
      }
    >
      <Icon name={wallet.authenticated ? "logout" : "wallet"} size={17} />
      <span>{label}</span>
    </Button>
  );
}
