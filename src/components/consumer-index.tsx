"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import type { PublishedIndexResponse } from "@/lib/frontend/research-contract";
import { useResource } from "@/lib/frontend/use-resource";
import { shortDate } from "@/lib/frontend/research-format";
import { getVaultReadiness, type VaultReadiness } from "@/lib/frontend/vault-api";
import { portraitFor } from "@/lib/fomo/portraits";
import { VaultFlow } from "./vault-flow";
import { Icon } from "./social/icon";
import { PageError, Skeleton, StockIcon } from "./social/shared";
import { AllocationBreakdown } from "./allocation-breakdown";
import { companyNameFor } from "@/lib/frontend/company-logos";
import styles from "./consumer-index.module.css";

function IndexModel({hash}:{hash:string}){
  const routeId=`fmp-${hash}`;
  const resource=useResource<PublishedIndexResponse>(`/api/published-indexes/${encodeURIComponent(hash)}`);
  const [vault,setVault]=useState<VaultReadiness|null>(null),[investOpen,setInvestOpen]=useState(false);
  const holdings=useMemo(()=>[...(resource.data?.index.constituents??[])].sort((a,b)=>b.weight_bps-a.weight_bps),[resource.data]);
  const max=Math.max(...holdings.map(h=>h.weight_bps),1);
  const index=resource.data?.index;
  useEffect(()=>{let alive=true;if(!index)return;getVaultReadiness(routeId).then(v=>{if(alive)setVault(v)}).catch(()=>{if(alive)setVault(null)});return()=>{alive=false}},[index,routeId]);
  if(resource.loading)return <Skeleton/>;
  if(resource.error)return <PageError error={resource.error} retry={resource.reload}/>;
  if(!index)return null;
  const excluded=index.definition?.excluded??[];const personImage=portraitFor(index.person_id);
  const live=Boolean(vault?.depositEnabled||vault?.ready);const preview=Boolean(vault?.identity||vault?.vault);
  return <div className={styles.page}>
    <div className={styles.breadcrumb}><Link href={`/p/${encodeURIComponent(index.person_id)}`}><Icon name="arrow" size={13} style={{transform:"rotate(180deg)"}}/>Person portfolio</Link><span>Published model</span></div>
    <section className={styles.hero}>
      <div className={styles.portrait}>{personImage?<img src={personImage} alt=""/>:<span>{index.indexName?.slice(0,2)??"II"}</span>}<b>INDEX</b></div>
      <div className={styles.heroCopy}><span>{index.status||"Published"} · public disclosure model</span><h1>{index.indexName||index.definition?.label||"Person index"}</h1><p>One target made from the mapped part of a public disclosure book. Unmapped names stay visible below instead of being quietly dropped.</p><div className={styles.meta}><b>{holdings.length}</b><span>mapped names</span>{index.period?<><i/><b>{index.period}</b><span>period</span></>:null}{index.published_at?<><i/><span>published {shortDate(index.published_at)}</span></>:null}</div><div className={styles.actions}><button className={styles.invest} onClick={()=>setInvestOpen(true)}>{live?"Invest in index":preview?"Preview index flow":"See index status"}<Icon name="arrow" size={14}/></button><Link href="/feed">Copy a single move</Link></div></div>
      <aside className={styles.state}><small>VAULT STATE</small><strong>{live?"Live":preview?"Preview":"Not live"}</strong><p>{live?"Deposit preparation can return real validated transactions.":preview?"The vault is observable, but signing stays off until prepare returns real transactions.":"This is a research model. No basket Buy is fabricated."}</p>{vault?.observedSlot?<span>Observed slot {vault.observedSlot.toLocaleString()}</span>:null}</aside>
    </section>

    <div className={styles.layout}><main>
      {holdings.length?<AllocationBreakdown title="Index allocation" subtitle="Breakdown by asset" items={holdings.map(h=>({ticker:h.ticker,name:companyNameFor(h.ticker,h.issuer),weight:h.weight_bps/10000}))}/>:null}
      <section className={styles.weights}><header><div><h2>Allocation</h2><p>Published target weights—not a claim about a live wallet balance.</p></div><span>{holdings.reduce((s,h)=>s+h.weight_bps,0)/100}% mapped target</span></header>{holdings.length?<div className={styles.rows}>{holdings.map((item,n)=><article className={styles.row} key={item.mint}><span>{String(n+1).padStart(2,"0")}</span><StockIcon ticker={item.ticker}/><div className={styles.ticker}><strong>{item.ticker}</strong><small>{companyNameFor(item.ticker,item.issuer)}</small></div><div className={styles.bar}><i style={{width:`${Math.max(2,item.weight_bps/max*100)}%`}}/></div><b>{(item.weight_bps/100).toFixed(item.weight_bps>=1000?1:2)}%</b></article>)}</div>:<div className={styles.empty}>No mapped constituents in this model.</div>}</section>
      <section className={styles.details}><div><h3>How it was built</h3><p>{index.definition?.basis||index.definition?.methodology||"A reproducible target derived from public disclosure evidence and verified token mappings."}</p></div><div><h3>What's excluded</h3>{excluded.length?excluded.slice(0,8).map((x,i)=><p key={i}><b>{x.ticker||x.name||"Unmapped asset"}</b> · {x.reason||"No verified supported mapping"}</p>):<p>No excluded rows were returned with this model.</p>}</div></section>
    </main><aside className={styles.side}><span>WHAT HAPPENS IF YOU INVEST?</span><h2>USDC in. One share position out.</h2><ol><li><b>1</b><div><strong>Review</strong><span>Amount, entry fee, network costs and blockers.</span></div></li><li><b>2</b><div><strong>Approve native steps</strong><span>Deposit and lock only when required by the contract.</span></div></li><li><b>3</b><div><strong>Vault settles</strong><span>Keeper handles prices, auctions and minting.</span></div></li><li><b>4</b><div><strong>Shares arrive</strong><span>Unused contribution cleanup can finish afterward.</span></div></li></ol><button onClick={()=>setInvestOpen(true)}>{live?"Start investment":"Open flow preview"}</button><small>Entry 0.25% host fee · exit 0% host fee · other protocol/network costs separate.</small></aside></div>
    <VaultFlow open={investOpen} onClose={()=>setInvestOpen(false)} indexId={routeId} indexName={index.indexName||"Person index"} readiness={vault}/>
  </div>;
}

function LegacyIndex({id}:{id:string}){const[investOpen,setInvestOpen]=useState(false);return <div className={styles.legacy}><span>LEGACY RESEARCH ROUTE</span><h1>This basket is read-only.</h1><p>The current contract does not expose a safe multi-asset Buy for legacy baskets. Copy an eligible disclosure or open a published person index instead.</p><div><Link href="/">Explore people</Link><Link href="/feed">Open Feed</Link></div><button onClick={()=>setInvestOpen(true)}>See why investing is unavailable</button><VaultFlow open={investOpen} onClose={()=>setInvestOpen(false)} indexId={id} indexName="Legacy basket" readiness={null}/></div>}

export function ConsumerIndex({id}:{id:string}){return id.startsWith("fmp-")?<IndexModel hash={id.slice(4)}/>:<LegacyIndex id={id}/>}
