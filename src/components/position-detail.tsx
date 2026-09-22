"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePrivySolana } from "./providers/privy-provider";
import { WalletButton } from "./wallet-button";
import { Icon } from "./social/icon";
import { StockIcon } from "./social/shared";
import { AllocationBreakdown } from "./allocation-breakdown";
import { getIndexPosition, getVaultReadiness, type IndexSharePosition, type VaultReadiness } from "@/lib/frontend/vault-api";
import { markedDollars } from "@/lib/frontend/research-format";
import { formatVaultShares } from "@/lib/index-vaults/positions-contract";
import { PREVIEW_MODE, errorText } from "@/lib/frontend/api";
import styles from "./position-detail.module.css";

export function PositionDetail({indexId}:{indexId:string}){
  const wallet=usePrivySolana();
  const [position,setPosition]=useState<IndexSharePosition|null>(null);
  const [readiness,setReadiness]=useState<VaultReadiness|null>(null);
  const [loading,setLoading]=useState(false);
  const [error,setError]=useState<string|null>(null);
  // Synchronize the wallet-scoped view with the external position endpoints.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(()=>{let alive=true;if(!wallet.solanaAddress){setPosition(null);return;}setLoading(true);setError(null);Promise.all([getIndexPosition(indexId,wallet.solanaAddress),getVaultReadiness(indexId).catch(()=>null)]).then(([p,r])=>{if(alive){setPosition(p);setReadiness(r)}}).catch(e=>{if(alive)setError(errorText(e))}).finally(()=>{if(alive)setLoading(false)});return()=>{alive=false}},[indexId,wallet.solanaAddress]);
  const weights=useMemo(()=>[...(readiness?.actualWeights?.length?readiness.actualWeights:readiness?.targetWeights??[])].sort((a,b)=>b.weightBps-a.weightBps),[readiness]);
  const name=position?.indexName??indexId;
  const sharesText=position?position.sharesText??formatVaultShares(position.sharesRaw,position.shareDecimals??0):null;
  if(!wallet.solanaAddress)return <div className={styles.page}><Link className={styles.back} href="/positions"><Icon name="arrow" size={13} style={{transform:"rotate(180deg)"}}/>Your portfolio</Link><div className={styles.gate}><span>POSITION DETAIL</span><h1>Connect to open<br/>this position.</h1><p>Share balances are wallet-scoped.</p><WalletButton/></div></div>;
  return <div className={styles.page}>
    <Link className={styles.back} href="/positions"><Icon name="arrow" size={13} style={{transform:"rotate(180deg)"}}/>Your portfolio</Link>
    {loading?<div className={styles.loading}>Reading share balance and native vault state…</div>:error?<div className={styles.error}>{error}</div>:!position?<div className={styles.gate}><span>NO POSITION</span><h1>No index shares found.</h1><p>This wallet does not hold index shares yet.</p><Link href={`/indexes/${encodeURIComponent(indexId)}`}>Open index</Link></div>:<>
      <section className={styles.hero}><div className={styles.photo}><span>YOUR INDEX</span></div><div className={styles.identity}><small>INDEX POSITION</small><h1>{name}</h1><div className={styles.numbers}><div><strong>{sharesText}</strong><span>shares</span></div><div><strong>{markedDollars(position.markedValueUsdc)}</strong><span>{position.priceBasis??"marked value"}</span></div></div><div className={styles.actions}><Link href={`/indexes/${encodeURIComponent(indexId)}`}>View index</Link></div>{PREVIEW_MODE?<p className={styles.preview}>DESIGN FLOW FIXTURE · no live NAV or transaction is implied.</p>:null}</div><aside><span>VAULT STATUS</span><strong>{readiness?.identity||readiness?.vault?"Observed":"Unavailable"}</strong><small>Share balance is read from your connected wallet.</small></aside></section>

      <div className={styles.grid}><section className={styles.panel}><header><h2>Inside your shares</h2><p>{readiness?.actualWeights?.length?"Observed backing weights":"Current published target"}</p></header>{weights.length?<><div className={styles.allocationWrap}><AllocationBreakdown title="Underlying allocation" subtitle="Your index exposure" items={weights.map(w=>({ticker:w.ticker??w.mint.slice(0,5),name:w.ticker?"Index constituent":"Vault asset",weight:w.weightBps/10000}))}/></div><div className={styles.weights}>{weights.slice(0,10).map((w,i)=><div key={w.mint}><span>{String(i+1).padStart(2,"0")}</span><StockIcon ticker={w.ticker??w.mint.slice(0,5)} size="sm"/><strong>{w.ticker??w.mint.slice(0,5)}</strong><i><b style={{width:`${Math.max(3,w.weightBps/Math.max(1,weights[0].weightBps)*100)}%`}}/></i><em>{(w.weightBps/100).toFixed(1)}%</em></div>)}</div></>:<div className={styles.empty}>Published holdings are unavailable right now.</div>}</section></div>

      {position.outstandingClaims?.length?<section className={styles.claims}><h2>Outstanding claims</h2>{position.outstandingClaims.map(c=><div key={c.mint}><strong>{c.symbol??c.mint.slice(0,7)}</strong><span>{c.amountRemainingRaw} raw units</span><b>{c.transferBlocked?"BLOCKED":"PENDING"}</b></div>)}</section>:null}
    </>}
  </div>;
}
