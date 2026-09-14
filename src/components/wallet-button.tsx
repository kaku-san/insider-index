"use client";

import Link from "next/link";
import { useRef } from "react";
import { Button } from "@/components/ui/button";
import { usePrivySolana } from "@/components/providers/privy-provider";
import { useUI } from "@/components/providers/ui-provider";
import { Icon } from "@/components/social/icon";
import { shortenAddress } from "@/lib/format";

export function WalletButton() {
  const wallet = usePrivySolana();
  const ui = useUI();
  const menu = useRef<HTMLDetailsElement>(null);
  const unavailable = wallet.mode === "unavailable";

  if (wallet.authenticated && wallet.solanaAddress) {
    const address = wallet.solanaAddress;
    return <details className="wallet-menu" ref={menu} onKeyDown={(event) => {
      if (event.key === "Escape" && menu.current) {
        menu.current.open = false;
        menu.current.querySelector("summary")?.focus();
      }
    }} onBlur={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false;
    }}>
      <summary className="button primary wallet-button" aria-label={`Wallet options for ${shortenAddress(address)}`}><Icon name="wallet" size={17} /><span>{shortenAddress(address)}</span></summary>
      <div className="wallet-menu-panel">
        <strong>{wallet.mode === "stub" ? "Local preview wallet" : "Your Solana wallet"}</strong>
        <code>{address}</code>
        <button onClick={() => void navigator.clipboard.writeText(address).then(() => ui.toast("Wallet address copied."), () => ui.toast("Could not copy. Select the address above."))}><Icon name="copy" size={16} />Copy address</button>
        <Link href="/positions" onClick={() => { if (menu.current) menu.current.open = false; }}><Icon name="wallet" size={16} />My positions</Link>
        <button onClick={() => void wallet.disconnect().catch(() => ui.toast("Could not disconnect. Please retry."))}><Icon name="logout" size={16} />Disconnect</button>
      </div>
    </details>;
  }

  return <Button className="button primary wallet-button" disabled={!wallet.ready}
    onClick={() => unavailable ? window.location.reload() : void wallet.connect().catch((error: unknown) => ui.toast(error instanceof Error ? error.message : "Wallet connection failed. Please retry."))}
    title={unavailable ? "Privy is unavailable. Reload to retry; no demo wallet will be connected." : "Connect through Privy. You approve every transaction."}>
    <Icon name={unavailable ? "refresh" : "wallet"} size={17} />
    <span>{!wallet.ready ? "Connecting…" : unavailable ? "Retry wallet" : wallet.authenticated ? "Create wallet" : wallet.mode === "stub" ? "Preview wallet" : "Connect wallet"}</span>
  </Button>;
}
