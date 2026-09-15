"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { WalletConnectSheet } from "./wallet-connect-sheet";
import { VaultFlow } from "./vault-flow";
import { usePrivySolana } from "./providers/privy-provider";
import { Icon } from "./social/icon";
import { getVaultReadiness, type IndexSharePosition, type VaultReadiness } from "@/lib/frontend/vault-api";
import { portraitFor } from "@/lib/frontend/portraits";
import styles from "./flow-lab.module.css";

const indexId="fmp-preview-nancy";
const previewPosition:IndexSharePosition={indexId,indexName:"Nancy P Index",owner:"7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",shareMint:"Cdxoni8uv7FrqVfeHJ6YC4DeXs3QQ2uG4nT3BDd9Ny2A",shareDecimals:6,sharesRaw:"91250000",sharesText:"91.25",markedValueUsdc:"1087.42",priceBasis:"DESIGN FLOW FIXTURE"};

const journey=[
  ["01","Discover","Home → person → published index","Public. No wallet required."],
  ["02","Connect","Wallet or email","Connection reveals positions. It never moves money."],
  ["03","Enter","USDC → native intent","Review costs → deposit approval → lock approval when required."],
  ["04","Settle","Keeper + native vault","Pricing → auctions → mint shares → unused contribution cleanup."],
  ["05","Hold","My Portfolio","One share position with independent pending-operation state."],
  ["06","Exit","Shares → basket","Redeem → claim every underlying token. No fake instant-USDC promise."],
  ["07","Choose","Basket or USDC","Keep the basket, or separately authorize sales of redeemed credits only."],
  ["08","Recover","Resume, don't repeat","Partial claims and failed conversions reopen from chain-verified state."],
] as const;

const endpoints=[
  ["READ","GET /api/indexes/:id/vault"],
  ["READ","GET /api/indexes/:id/position?owner=…"],
  ["WRITE","POST /api/indexes/:id/deposit/prepare"],
  ["WRITE","POST /api/indexes/:id/withdraw/prepare"],
  ["WRITE","POST /api/operations/:id/receipts"],
  ["READ","GET /api/operations/:id"],
  ["WRITE","POST /api/operations/:id/next"],
  ["WRITE","POST /api/operations/:id/convert/prepare"],
  ["WRITE","POST /api/operations/:id/recovery/prepare"],
] as const;

export function FlowLab(){
  const wallet=usePrivySolana();
  const[connectOpen,setConnectOpen]=useState(false),[entryOpen,setEntryOpen]=useState(false),[exitOpen,setExitOpen]=useState(false),[readiness,setReadiness]=useState<VaultReadiness|null>(null);
  useEffect(()=>{getVaultReadiness(indexId).then(setReadiness).catch(()=>setReadiness(null))},[]);
  return <div className={styles.page}>
    <header className={styles.hero}><div><span>INSIDERINDEX / FLOW LAB</span><h1>From famous portfolio<br/>to your portfolio.</h1><p>This is the end-to-end consumer journey and the contract boundary behind it. The interactive approvals are design simulations in preview mode; real money actions stay fail-closed until the backend returns validated native transactions.</p></div><div className={styles.heroArt}><img src={portraitFor("nancy-pelosi")??""} alt=""/><div><small>PERSON INDEX</small><strong>Nancy P Index</strong><span>DISCOVER → INVEST → HOLD → EXIT</span></div></div></header>

    <section className={styles.launch}><button onClick={()=>setConnectOpen(true)}><Icon name="wallet" size={17}/><span><small>01</small><strong>{wallet.authenticated?"Connected wallet":"Connect flow"}</strong></span></button><Link href="/indexes/fmp-preview-nancy"><Icon name="grid" size={17}/><span><small>02</small><strong>Index detail</strong></span></Link><button onClick={()=>setEntryOpen(true)}><Icon name="arrow" size={17}/><span><small>03</small><strong>Enter index</strong></span></button><Link href="/positions"><Icon name="wallet" size={17}/><span><small>04</small><strong>My portfolio</strong></span></Link><Link href="/positions/fmp-preview-nancy"><Icon name="file" size={17}/><span><small>05</small><strong>Position detail</strong></span></Link><button onClick={()=>setExitOpen(true)}><Icon name="arrow" size={17} style={{transform:"rotate(180deg)"}}/><span><small>06</small><strong>Exit index</strong></span></button><Link href="/operations/demo-withdraw-nancy"><Icon name="info" size={17}/><span><small>07</small><strong>Resume operation</strong></span></Link></section>

    <section className={styles.journey}><div className={styles.heading}><div><span>USER JOURNEY</span><h2>Every screen has one job.</h2></div><p>Connect is identity. Approval is authorization. Settlement is observable state. Exit is redemption first, optional token sale second.</p></div><div className={styles.timeline}>{journey.map(([n,title,route,copy])=><article key={n}><b>{n}</b><div><h3>{title}</h3><span>{route}</span><p>{copy}</p></div></article>)}</div></section>

    <section className={styles.flowScreens}><div className={styles.heading}><div><span>ENTRY STATE MACHINE</span><h2>USDC → shares</h2></div><button onClick={()=>setEntryOpen(true)}>Open interactive entry</button></div><div className={styles.phaseStrip}>{["Amount","Review","Connect","Deposit approval","Lock approval","Pricing","Auctions","Shares received","Return cleanup","Complete"].map((x,i)=><div key={x}><b>{String(i+1).padStart(2,"0")}</b><span>{x}</span></div>)}</div></section>

    <section className={styles.flowScreens}><div className={styles.heading}><div><span>EXIT STATE MACHINE</span><h2>Shares → basket → optional USDC</h2></div><button onClick={()=>setExitOpen(true)}>Open interactive exit</button></div><div className={styles.phaseStrip}>{["Shares","Review","Redeem approval","Claim pending","Tokens received","Keep basket / Convert","Jupiter approvals","Partial / Complete","Recovery if needed"].map((x,i)=><div key={x}><b>{String(i+1).padStart(2,"0")}</b><span>{x}</span></div>)}</div></section>

    <section className={styles.contract}><div className={styles.heading}><div><span>FRONTEND ↔ BACKEND</span><h2>The endpoint contract</h2></div><p>These are the interfaces the redesigned screens call. Production must verify native state and receipts server-side; client status is never authoritative.</p></div><div className={styles.endpointGrid}>{endpoints.map(([verb,path])=><div key={path}><b className={verb==="READ"?styles.read:styles.write}>{verb}</b><code>{path}</code></div>)}</div></section>

    <section className={styles.guardrail}><Icon name="shield" size={21}/><div><strong>What this preview does not fake</strong><p>No private wallet, no contract signature, no live NAV, no guaranteed aggregate-USDC exit. When the real adapter is absent, money actions stop rather than falling back to the retired basket stub.</p></div></section>

    <WalletConnectSheet open={connectOpen} onClose={()=>setConnectOpen(false)}/>
    <VaultFlow open={entryOpen} onClose={()=>setEntryOpen(false)} indexId={indexId} indexName="Nancy P Index" readiness={readiness}/>
    <VaultFlow open={exitOpen} onClose={()=>setExitOpen(false)} indexId={indexId} indexName="Nancy P Index" readiness={readiness} mode="withdraw" position={previewPosition}/>
  </div>;
}
