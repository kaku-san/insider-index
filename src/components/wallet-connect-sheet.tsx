"use client";
import { useState } from "react";
import { createPortal } from "react-dom";
import { usePrivySolana, type WalletConnectMethod } from "./providers/privy-provider";
import { EXTERNAL_WALLET_REQUIRED } from "@/lib/frontend/privy-wallet-selection";
import { Icon } from "./social/icon";
import { PREVIEW_MODE, errorText } from "@/lib/frontend/api";
import { shortenAddress } from "@/lib/format";
import styles from "./wallet-connect-sheet.module.css";

export function WalletConnectSheet({open,onClose}:{open:boolean;onClose:()=>void}){
  const wallet=usePrivySolana();
  const [busy,setBusy]=useState<WalletConnectMethod|"disconnect"|null>(null);
  const [error,setError]=useState<string|null>(null);
  if(!open)return null;
  async function connect(method:WalletConnectMethod){setBusy(method);setError(null);try{await wallet.connect(method);onClose();}catch(e){setError(errorText(e));}finally{setBusy(null)}}
  async function disconnect(){setBusy("disconnect");setError(null);try{await wallet.disconnect();onClose();}catch(e){setError(errorText(e));}finally{setBusy(null)}}
  // Privy embedded wallets are never offered: a legacy embedded-only session must connect an external one.
  const embeddedOnly=Boolean(wallet.authenticated&&wallet.embeddedOnly);
  const dialog=<div className={styles.backdrop} onMouseDown={(e)=>{if(e.currentTarget===e.target)onClose()}}>
    <section className={styles.sheet} role="dialog" aria-modal="true" aria-label="Connect to InsiderIndex">
      <header className={styles.head}><div><small>INSIDERINDEX WALLET</small><h2>{wallet.authenticated&&!embeddedOnly?"You’re connected.":"Connect once. Stay in control."}</h2><p>{wallet.authenticated&&!embeddedOnly?"Your portfolio and operation receipts are scoped to this wallet.":"Follow portfolios without a wallet. Connect only when you want to view positions or sign a money action."}</p></div><button onClick={onClose} aria-label="Close"><Icon name="close" size={20}/></button></header>
      {PREVIEW_MODE?<div className={styles.preview}>Design preview · connection is local only. Signing and broadcasting stay disabled.</div>:null}
      {embeddedOnly?<div className={styles.preview} role="status" data-embedded-only="true">{EXTERNAL_WALLET_REQUIRED}</div>:null}
      {wallet.authenticated&&wallet.solanaAddress&&!embeddedOnly?<><div className={styles.connected}><div className={styles.walletCard}><div><small>Connected external wallet</small><code>{shortenAddress(wallet.solanaAddress,8)}</code></div><Icon name="check" size={22}/></div><button className={styles.disconnect} disabled={Boolean(busy)} onClick={()=>void disconnect()}>{busy==="disconnect"?"Disconnecting…":"Disconnect"}</button></div>{wallet.solanaWallets.length>1?<div className={styles.choices}>{wallet.solanaWallets.map(address=><button key={address} className={styles.walletPick} disabled={Boolean(busy)||address===wallet.solanaAddress} onClick={()=>wallet.selectSolanaWallet(address)}><span className={styles.walletPickText}><strong>{address===wallet.solanaAddress?"Using this wallet":"Use this wallet"}</strong><span className={styles.walletPickAddress}>{shortenAddress(address,8)}</span></span><small>{wallet.solanaWalletLabels?.[address]??"External wallet"}</small></button>)}</div>:null}</>:<div className={styles.choices}>
        <button className={styles.choice} disabled={Boolean(busy)} onClick={()=>void connect("wallet")}><span className={styles.choiceIcon}><Icon name="wallet" size={20}/></span><span><strong>{busy==="wallet"?"Connecting…":"Connect Phantom or Solana wallet"}</strong><span>Phantom, Solflare or another compatible Solana wallet via Privy. External wallets only — no email login or Privy-created wallet.</span></span><b className={styles.arrow}>›</b></button>
      </div>}
      {error?<div className={styles.preview} role="alert">{error}</div>:null}
      <p className={styles.fine}>Connecting never authorizes a trade. Every copy, deposit and redemption has its own review and wallet approval step.</p>
    </section>
  </div>;
  return typeof document==="undefined"?dialog:createPortal(dialog,document.body)
}
