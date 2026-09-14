"use client";
import {useMemo,useState} from "react";
import Link from "next/link";
import {useRouter} from "next/navigation";
import {useResource} from "@/lib/frontend/use-resource";
import {PREVIEW_MODE} from "@/lib/frontend/api";
import {portraitFor} from "@/lib/frontend/portraits";
import {usePrivySolana} from "@/components/providers/privy-provider";
import {IndexCard} from "./index-card";
import {SignalCard} from "./signal-card";
import {FollowButton} from "./follow-button";
import {CopyButton} from "./copy-button";
import {PersonAvatar} from "./person-avatar";
import {Icon} from "./social/icon";
import {PageError,Skeleton,EmptyState,StockIcon} from "./social/shared";
import type {Disclosure,PersonIndex,CopySignal} from "@/lib/disclosures/types";
import type {Follow} from "@/lib/frontend/contracts";
import {INDEX_RULES,indexReadiness,isCountableBuy,isCrowdIndex} from "@/lib/fomo/index-readiness";
import {formatDate} from "@/lib/format";
type Filer={id:string;name:string;kind:Disclosure["kind"];filings:number;latestBuy:Disclosure|null;latest:Disclosure;index:PersonIndex|null};
function scrollTo(id:string){document.getElementById(id)?.scrollIntoView({behavior:matchMedia("(prefers-reduced-motion: reduce)").matches?"auto":"smooth",block:"start"});}
export function IndexHome({initialIndexes,initialDisclosures}:{initialIndexes?:PersonIndex[];initialDisclosures?:Disclosure[]}={}){
 const wallet=usePrivySolana(),router=useRouter();
 const indexesRes=useResource<{indexes:PersonIndex[]}>("/api/indexes",initialIndexes?{indexes:initialIndexes}:undefined),disclosuresRes=useResource<{disclosures:Disclosure[]}>("/api/disclosures",initialDisclosures?{disclosures:initialDisclosures}:undefined),followsRes=useResource<{follows:Follow[]}>(wallet.solanaAddress?`/api/follows?wallet=${encodeURIComponent(wallet.solanaAddress)}`:null);
 const indexes=indexesRes.data?.indexes??[],disclosures=disclosuresRes.data?.disclosures??[],follows=followsRes.data?.follows??[];
 // Readiness windows are judged against the time this page mounted; a refresh re-mounts.
 const [now]=useState(()=>Date.now());
 const rated=useMemo(()=>indexes.map(index=>({index,readiness:indexReadiness(index,disclosures,now)})),[indexes,disclosures,now]);
 const ready=rated.filter(r=>r.readiness.ready).sort((a,b)=>Number(isCrowdIndex(b.index))-Number(isCrowdIndex(a.index))||b.readiness.buys-a.readiness.buys);
 const building=rated.filter(r=>!r.readiness.ready&&isCrowdIndex(r.index));
 const filers=useMemo<Filer[]>(()=>{const byId=new Map<string,Disclosure[]>();for(const d of disclosures){byId.set(d.profileId,[...(byId.get(d.profileId)??[]),d]);}
  return [...byId.entries()].map(([id,rows])=>{const sorted=[...rows].sort((a,b)=>Date.parse(b.filedAt)-Date.parse(a.filedAt));return {id,name:sorted[0].insiderName,kind:sorted[0].kind,filings:rows.length,latestBuy:sorted.find(d=>isCountableBuy(d,now))??null,latest:sorted[0],index:indexes.find(i=>i.profileId===id)??null};}).sort((a,b)=>Date.parse(b.latest.filedAt)-Date.parse(a.latest.filedAt));},[disclosures,indexes,now]);
 const followable=filers.filter(f=>f.latestBuy);
 const readyIds=new Set(ready.map(r=>r.index.profileId));
 const radar=useMemo(()=>Object.entries(disclosures.filter(d=>isCountableBuy(d,now)).reduce<Record<string,Set<string>>>((out,d)=>{(out[d.ticker]??=new Set()).add(d.profileId);return out;},{})).map(([ticker,set])=>[ticker,set.size] as const).sort((a,b)=>b[1]-a[1]).slice(0,5),[disclosures,now]);
 const latest=useMemo<CopySignal[]>(()=>[...disclosures].sort((a,b)=>Date.parse(b.filedAt)-Date.parse(a.filedAt)).slice(0,4).map(d=>({...d,headline:"",fomoLabel:"",imageUrl:portraitFor(d.profileId)})),[disclosures]);
 const buyers=new Set(disclosures.filter(d=>isCountableBuy(d,now)).map(d=>d.profileId)).size;
 if((indexesRes.error||disclosuresRes.error)&&!indexes.length&&!disclosures.length)return <PageError error={indexesRes.error??disclosuresRes.error!} retry={()=>{indexesRes.reload();disclosuresRes.reload();}}/>;
 if((indexesRes.loading||disclosuresRes.loading)&&!indexes.length&&!disclosures.length)return <Skeleton cards={4}/>;
 return <div className="index-home">
 <div className="page-intro"><div><span className="eyebrow"><span className="tiny-star">✳</span> PUBLIC FILINGS, TURNED INTO BASKETS.</span><h1>Buy what they file<span className="accent-dot">.</span></h1></div><span className="outlined-pill intro-pill"><Icon name="file" size={14}/>{disclosures.length} {PREVIEW_MODE?"example":"public"} filings · {buyers} buying in the last {INDEX_RULES.windowDays}d</span></div>
 <section className="hero"><div className="hero-copy"><span className="hero-eyebrow"><span className="status-dot"/>INDEXES FIRST. COPY ONE TRADE AS THE FALLBACK.</span><h2>Enough people<br/>buying the same thing<span>↗</span></h2><p>When enough filers buy, that becomes an index you can hold.<br/>When it’s only one person, follow them and copy the trade.</p><button className="button ink" onClick={()=>scrollTo("indexes")}>Browse the indexes<Icon name="arrow" size={17}/></button><span className="hero-fineprint">Every order is quoted, then signed by you. No autopilot.</span></div><div className="hero-art" aria-hidden="true"><span className="hero-orbit orbit-one"/><span className="hero-orbit orbit-two"/><span className="hero-spark">✳</span><div className="hero-ticket ticket-back"><img src="/portraits/dan-crenshaw.jpg" alt=""/><span>FILED A BUY</span></div><div className="hero-ticket ticket-front"><div className="ticket-top"><span>CAPITOL BUYS</span><Icon name="landmark" size={16}/></div><img src="/portraits/nancy-pelosi.jpg" alt=""/><div className="ticket-bottom"><strong>Public record.</strong><span>Turned into one basket.</span></div></div><span className="sticker sticker-purple">ONE BASKET.<br/><strong>MANY FILERS 👀</strong></span><span className="sticker sticker-white">100% public.<br/>0% crystal ball.</span></div></section>

 <section id="indexes" className="home-section"><div className="section-heading"><div><h2><Icon name="grid" size={19}/>Indexes<span className="heading-dot"/></h2><p>A basket only shows up here when enough real filings back it.</p></div><button className="icon-button" aria-label="Refresh indexes" onClick={()=>{indexesRes.reload();disclosuresRes.reload();}}><Icon name="refresh" size={17}/></button></div>
 {ready.length?<div className="index-grid">{ready.map(r=><IndexCard key={r.index.id} index={r.index} readiness={r.readiness}/>)}</div>:<EmptyState title="No index is ready yet." description={`An index needs at least ${INDEX_RULES.crowd.minFilers} filers buying ${INDEX_RULES.crowd.minXStocks} allowlisted xStocks in ${INDEX_RULES.windowDays} days (or one filer with ${INDEX_RULES.person.minBuys} buys across ${INDEX_RULES.person.minXStocks} xStocks). We won’t pad it. Until then, follow a filer below and copy their next buy.`} action={followable.length?"Follow someone instead":undefined} onAction={followable.length?()=>scrollTo("follow-copy"):undefined}/>}
 {building.length?<div className="building-list">{building.map(r=><div key={r.index.id} className="building-row"><PersonAvatar name={r.index.name} imageUrl={null} size="sm"/><div><strong>{r.index.name}</strong><span>{r.readiness.need} So far: {r.readiness.filers} filer{r.readiness.filers===1?"":"s"}, {r.readiness.xstocks} xStock{r.readiness.xstocks===1?"":"s"}.</span></div><Link className="text-button" href={`/indexes/${encodeURIComponent(r.index.id)}`}>Watch it fill<Icon name="up" size={13}/></Link></div>)}</div>:null}
 </section>

 <section className="explainer-grid" aria-label="Index or copy one trade"><div className="panel explainer"><span className="mini-label">OPTION ONE</span><h3><Icon name="grid" size={17}/>Buy an index</h3><p>One basket of xStocks, weighted by what real filers actually bought. You pick a USDC amount, get one quote, sign once. When a new filing changes the weights, you review the rebalance before anything moves.</p><span className="explainer-when">Best when many people are buying the same names.</span></div><div className="panel explainer"><span className="mini-label">OPTION TWO · THE FALLBACK</span><h3><Icon name="copy" size={17}/>Follow &amp; copy one trade</h3><p>Follow a person. When they disclose a buy in an allowlisted xStock, you can buy the same xStock at today’s price — after you approve it in your wallet. Whatever they buy, you buy. Nothing happens without your signature.</p><span className="explainer-when">Best when there aren’t enough filings for a basket yet.</span></div></section>

 <div className="discovery-layout"><div className="feed-column">
 <section id="follow-copy" className="home-section"><div className="section-heading"><div><h2><Icon name="people" size={19}/>Follow &amp; copy<span className="heading-dot"/></h2><p>People with a recent allowlisted buy. Follow them, or copy the exact trade.</p></div></div>
 {followsRes.error?<div className="notice error" role="alert">Could not load your follows.<button onClick={followsRes.reload}>Retry</button></div>:null}
 {followable.length?<div className="filer-list">{followable.slice(0,8).map(f=><div key={f.id} className="filer-row"><Link href={`/p/${encodeURIComponent(f.id)}`} className="filer-identity"><PersonAvatar name={f.name} imageUrl={portraitFor(f.id)}/><div><strong>{f.name}</strong><span>{f.kind==="politician"?"Congress":"Executive"} · {f.filings} filing{f.filings===1?"":"s"} · bought <b>{f.latestBuy!.xstockSymbol??f.latestBuy!.ticker}</b> {PREVIEW_MODE?"(example)":formatDate(f.latestBuy!.filedAt)}</span></div></Link><StockIcon ticker={f.latestBuy!.ticker} size="sm"/><div className="filer-actions"><FollowButton profileId={f.id} follow={follows.find(x=>x.profileId===f.id)} onChanged={followsRes.reload} compact/><CopyButton signalId={f.latestBuy!.id} enabled label="Copy this buy"/></div><span className="filer-note">{readyIds.has(f.id)?<Link href={`/indexes/${encodeURIComponent(f.index!.id)}`}>Also has an index<Icon name="up" size={11}/></Link>:"Too few filings for an index — copy one trade instead."}</span></div>)}</div>:<EmptyState title="Nobody has a recent allowlisted buy." description={`No filer bought an xStock we can trade in the last ${INDEX_RULES.windowDays} days. Nothing to copy yet — check the feed for everything else.`} action="Open the feed" onAction={()=>router.push("/feed")}/>}
 {followable.length>8?<Link className="text-button center" href="/feed">See everyone on the tape<Icon name="arrow" size={13}/></Link>:null}
 </section>
 <section className="home-section"><div className="section-heading"><div><h2><Icon name="bolt" size={19}/>Latest filings<span className="heading-dot"/></h2><p>The raw tape. Disclosures arrive days after the trade.</p></div><Link className="button secondary" href="/feed">Open the full feed<Icon name="arrow" size={15}/></Link></div>
 {latest.length?<div className="signal-list">{latest.map(s=><SignalCard key={s.id} signal={s}/>)}</div>:<EmptyState title="No filings yet." description="The tape is empty right now. We won’t invent a filing."/>}
 </section></div>
 <aside className="discovery-rail"><section className="rail-card"><div className="rail-heading"><h3><Icon name="eye" size={18}/>Most bought</h3><span>{INDEX_RULES.windowDays}d</span></div><p className="rail-subtitle">Distinct filers buying each xStock</p>{radar.length?<div className="radar-list">{radar.map(([ticker,count],i)=><Link key={ticker} href={`/feed?q=${encodeURIComponent(ticker)}`}><span className="radar-rank">{i+1}</span><StockIcon ticker={ticker} size="sm"/><strong>{ticker}</strong><span>{count} filer{count===1?"":"s"}</span><Icon name="up" size={14}/></Link>)}</div>:<p className="small-text muted">No allowlisted buys in the window.</p>}</section>
 <section className="rail-note"><span className="note-pin"/><span className="mini-label">HOW TO READ THIS</span><h3>Index when it’s many.<br/>Copy when it’s one.</h3><p>A basket needs {INDEX_RULES.crowd.minFilers}+ filers. One person filing one buy is a trade to copy, not an index. We keep those separate on purpose.</p></section>
 <div className="rail-fineprint"><Icon name="info" size={15}/><p>{PREVIEW_MODE?"All filings, weights, and curves shown here are synthetic design examples. Portraits identify example profiles, not actual activity.":"Disclosures arrive after the original trades. Index weights come from public filings, not a live portfolio. Historical returns are not forecasts."}</p></div></aside></div>
 </div>;
}
