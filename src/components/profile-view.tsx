"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useResource } from "@/lib/frontend/use-resource";
import type { CopySignal, FomoProfile } from "@/lib/disclosures/types";
import type { PersonPortfolioResponse, ResearchActivity, ResearchItem } from "@/lib/frontend/research-contract";
import { moneyBand, personContext, shortDate, slugifyPerson, stockActBandFromMidpoint } from "@/lib/frontend/research-format";
import { portraitFor } from "@/lib/fomo/portraits";
import { useUI } from "./providers/ui-provider";
import { PageError, Skeleton, StockIcon } from "./social/shared";
import { AllocationBreakdown } from "./allocation-breakdown";
import { FilingLink } from "./person-portfolio";
import { companyNameFor } from "@/lib/frontend/company-logos";
import { Icon } from "./social/icon";
import { VaultFlow } from "./vault-flow";
import { usePrivySolana } from "./providers/privy-provider";
import { PREVIEW_MODE } from "@/lib/frontend/api";
import { getIndexPosition, getVaultReadiness, hasIndexShares, publicIndexIsLive, publicIndexStatus, vaultReadinessFromIndex, type IndexSharePosition, type VaultReadiness } from "@/lib/frontend/vault-api";
import type { PublicVaultDefinition } from "@/lib/index-vaults/vault-definition-store";
import type { TrackerPerson, TrackerPersonResponse } from "@/lib/tracker/types";
import { formatUsd } from "@/lib/format";
import styles from "./consumer-person.module.css";

type LegacyProfileData = { profile: FomoProfile; trades: CopySignal[] };
type HoldingView = { key:string; ticker:string; name:string; weightPct:number|null; venue:string|null; mint:string|null; disclosedValue?:string|null };
type ActivityView = { id:string; ticker:string; name:string; side:"buy"|"sell"|"other"; tradeDate:string|null; filedDate:string|null; amount:string; sourceUrl?:string|null; copyHref?:string|null };


const fmtWeight=(v:number|null)=>v==null||!Number.isFinite(v)?"—":`${(v*100).toFixed(v*100>=10?0:1)}%`;
function eventSide(value?:string|null):ActivityView["side"]{if(/purchase|buy/i.test(value??""))return"buy";if(/sale|sell/i.test(value??""))return"sell";return"other"}

function researchHoldings(book:PersonPortfolioResponse):HoldingView[]{
 const index=book.publishedIndex;
 const snapshot=[...(book.snapshots??[])].sort((a,b)=>(b.referenceDate??"").localeCompare(a.referenceDate??""))[0];
 const items=snapshot?.items??[];
 const tickerCounts=new Map<string,number>();
 for(const item of items){if(item.ticker)tickerCounts.set(item.ticker,(tickerCounts.get(item.ticker)??0)+1)}
 const evidenceByHolding=new Map((index?.definition?.evidence??[]).flatMap(evidence=>evidence.holding?.id&&evidence.token?.mint?[[evidence.holding.id,evidence.token.mint] as const]:[]));
 return items.map(item=>{
  const evidencedMint=evidenceByHolding.get(item.id);
  const constituent=index?.constituents.find(candidate=>candidate.mint===(evidencedMint??item.token?.mint))??(item.ticker&&tickerCounts.get(item.ticker)===1?index?.constituents.find(candidate=>candidate.ticker===item.ticker):undefined);
  return {key:item.id,ticker:item.ticker??item.name??"—",name:item.name??"Disclosed asset",weightPct:null,venue:constituent?.issuer??item.token?.issuer??null,mint:constituent?.mint??item.token?.mint??null,disclosedValue:moneyBand(item.valueRange)};
 });
}
function researchAllocation(book:PersonPortfolioResponse):HoldingView[]{return [...(book.publishedIndex?.constituents??[])].sort((a,b)=>b.weight_bps-a.weight_bps).map(item=>({key:item.mint,ticker:item.ticker,name:companyNameFor(item.ticker,item.issuer),weightPct:item.weight_bps/10000,venue:item.issuer,mint:item.mint}))}
function trackerHoldings(person:TrackerPerson):HoldingView[]{return person.holdings.map((item,index)=>({key:`${item.ticker??item.name??index}`,ticker:item.ticker??"—",name:item.name??"Tracked holding",weightPct:typeof item.percentage==="number"&&item.percentage>0?item.percentage/100:null,venue:"PelosiTracker estimate",mint:null,disclosedValue:typeof item.value==="number"&&item.value>0?formatUsd(item.value):null}))}
function trackerActivity(person:TrackerPerson):ActivityView[]{return person.trades.map((item,index)=>({id:`tracker-${person.id}-${index}`,ticker:item.ticker??"—",name:item.ticker??"Tracked trade",side:eventSide(item.type),tradeDate:item.date,filedDate:item.notificationDate??item.date,amount:moneyBand(stockActBandFromMidpoint(item.amount))}))}
function legacyHoldings(profile:FomoProfile):HoldingView[]{return [...profile.portfolio].sort((a,b)=>b.weightPct-a.weightPct).map(item=>({key:item.mint??item.ticker,ticker:item.ticker,name:companyNameFor(item.ticker,item.issuerName),weightPct:Number.isFinite(item.weightPct)&&item.weightPct>0?item.weightPct:null,venue:item.venue==="none"?null:item.venue,mint:item.mint,disclosedValue:moneyBand({low:item.valueLow,high:item.valueHigh})}))}
function researchActivity(book:PersonPortfolioResponse):ActivityView[]{return [...(book.activity??[])].sort((a,b)=>(b.transactionDate??b.disclosureDate??"").localeCompare(a.transactionDate??a.disclosureDate??"")).map((item:ResearchActivity)=>({id:item.id,ticker:item.ticker??item.name??"Asset",name:item.name??"Public disclosure",side:eventSide(item.event),tradeDate:item.transactionDate??null,filedDate:item.disclosureDate??null,amount:moneyBand(item.amount),sourceUrl:item.sourceUrl}))}
function legacyActivity(trades:CopySignal[]):ActivityView[]{return [...trades].sort((a,b)=>b.transactionDate.localeCompare(a.transactionDate)).map(item=>({id:item.id,ticker:item.ticker,name:item.issuerName,side:item.side,tradeDate:item.transactionDate,filedDate:item.filedAt,amount:moneyBand({low:item.amountLow,high:item.amountHigh}),copyHref:item.tradeEligible?`/trade/${encodeURIComponent(item.id)}?copy=1`:null}))}

function Portrait({name,image}:{name:string;image:string|null}){const[failed,setFailed]=useState(false);return <div className={styles.portrait}>{image&&!failed?<img src={image} alt={name} onError={()=>setFailed(true)}/>:<span>{name.split(" ").map(x=>x[0]).join("").slice(0,2)}</span>}</div>}

function PerformanceGraphic({profile,activity,series,caption}:{profile:FomoProfile|null;activity:ActivityView[];series?:{label:string;equity:number}[];caption?:string}){
 const [range,setRange]=useState("1Y");
 const [hover,setHover]=useState<number|null>(null);
 const allPoints=(series??profile?.curve)?.filter(p=>Number.isFinite(p.equity))??[];
 const take=range==="1M"?Math.min(2,allPoints.length):range==="3M"?Math.min(4,allPoints.length):range==="6M"?Math.min(7,allPoints.length):allPoints.length;
 const points=allPoints.slice(Math.max(0,allPoints.length-take));
 if(points.length<2)return <div className={styles.chartUnavailable}><div className={styles.chartGhost}><i/><i/><i/><i/></div><div><strong>Performance connects when price history does.</strong><span>InsiderIndex never converts disclosure amounts into fake returns.</span></div></div>;
 const width=1000,height=360,pad=20;const min=Math.min(...points.map(p=>p.equity)),max=Math.max(...points.map(p=>p.equity)),span=max-min||1;
 const coords=points.map((p,i)=>({x:pad+i/Math.max(1,points.length-1)*(width-pad*2),y:height-pad-(p.equity-min)/span*(height-pad*2),label:p.label,equity:p.equity}));
 const poly=coords.map(p=>`${p.x},${p.y}`).join(" ");const first=points[0].equity,last=points.at(-1)!.equity,change=first?(last-first)/Math.abs(first):0;
 const markers=activity.slice(0,3).map((item,i)=>({item,point:coords[Math.max(1,Math.min(coords.length-2,Math.round((coords.length-1)*(.38+i*.2))))]}));
 return <div className={styles.performanceWrap}>
   <div className={styles.performanceHead}><div><span>{PREVIEW_MODE?"DESIGN PREVIEW CURVE":"HISTORICAL MODEL"}</span><strong>{change>=0?"+":""}{(change*100).toFixed(1)}%</strong><small>{points[0].label} → {points.at(-1)!.label}</small></div><div className={styles.rangeTabs}>{["1M","3M","6M","1Y","ALL"].map(x=><button key={x} className={range===x?styles.activeRange:""} onClick={()=>setRange(x)}>{x}</button>)}</div></div>
   <div className={styles.chartCanvas} onPointerLeave={()=>setHover(null)} onPointerMove={(event)=>{const rect=event.currentTarget.getBoundingClientRect();const ratio=Math.max(0,Math.min(1,(event.clientX-rect.left)/Math.max(1,rect.width)));setHover(Math.round(ratio*(coords.length-1)));}}>
     <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label={`Historical model performance ${(change*100).toFixed(1)} percent`}>
       {[90,180,270].map(y=><line key={y} x1="0" y1={y} x2={width} y2={y} className={styles.gridLine}/>) }
       <path d={`M ${coords[0].x} ${height-pad} `+coords.map(p=>`L ${p.x} ${p.y}`).join(" ")+` L ${coords.at(-1)!.x} ${height-pad} Z`} className={styles.area}/>
       <polyline points={poly} className={styles.performanceLine} vectorEffect="non-scaling-stroke"/>
       {markers.map(({item,point})=><g key={item.id} className={styles.marker}><line x1={point.x} x2={point.x} y1={point.y+8} y2={height} /><circle cx={point.x} cy={point.y} r="6"/></g>)}
     </svg>
     {markers.map(({item,point},i)=><div key={item.id} className={`${styles.eventChip} ${i===1?styles.eventChipAlt:""}`} style={{left:`${point.x/width*100}%`,top:`${Math.max(8,point.y/height*100-4)}%`}}><b>{item.side==="buy"?"BUY":item.side==="sell"?"SELL":"FILE"} {item.ticker}</b><span>{item.amount}</span></div>)}
     {hover!=null&&coords[hover]?<div className={styles.scrub} style={{left:`${coords[hover].x/width*100}%`}}><i/><div><b>{coords[hover].label}</b><span>{((coords[hover].equity/points[0].equity-1)*100)>=0?"+":""}{((coords[hover].equity/points[0].equity-1)*100).toFixed(1)}%</span></div></div>:null}
   </div>
   <div className={styles.chartFooter}><span>{caption??(PREVIEW_MODE?"Illustrative curve for design review · holdings/activity snapshot is sourced":"Hindsight reconstruction · not live account performance")}</span><span>Drag/scrub interaction plugs into the production chart data layer.</span></div>
 </div>
}

function ShareSheet({open,onClose,name,indexName,image,profile,holdings}:{open:boolean;onClose:()=>void;name:string;indexName:string;image:string|null;profile:FomoProfile|null;holdings:HoldingView[]}){
 const[copied,setCopied]=useState(false);if(!open)return null;const pts=profile?.curve??[];const ret=pts.length>1&&pts[0].equity?((pts.at(-1)!.equity-pts[0].equity)/Math.abs(pts[0].equity))*100:null;
 async function copy(){try{await navigator.clipboard.writeText(window.location.href);setCopied(true);setTimeout(()=>setCopied(false),1200)}catch{}}
 async function share(){try{if(navigator.share)await navigator.share({title:`${indexName} · InsiderIndex`,url:window.location.href});else await copy()}catch{}}
 return <div className={styles.shareBackdrop} onMouseDown={e=>{if(e.currentTarget===e.target)onClose()}}><section className={styles.shareSheet} role="dialog" aria-modal="true">
   <header><div><strong>Ready for the group chat.</strong><span>Share the portfolio, not a spreadsheet.</span></div><button onClick={onClose} aria-label="Close"><Icon name="close" size={17}/></button></header>
   <div className={styles.storyCard}><div className={styles.storyBrand}>InsiderIndex<span>®</span></div><Portrait name={name} image={image}/><div className={styles.storyCopy}><small>PERSON INDEX</small><h2>{indexName}</h2>{ret!=null?<strong>{ret>=0?"+":""}{ret.toFixed(1)}%</strong>:<strong>{holdings.length} names</strong>}<span>{ret!=null?(PREVIEW_MODE?"design preview curve":"historical model return"):"public disclosure model"}</span></div><div className={styles.storyFooter}><span>PUBLIC FILINGS → INDEX</span><span>InsiderIndex.xyz</span></div></div>
   <div className={styles.shareActions}><button className={styles.sharePrimary} onClick={()=>void share()}><Icon name="share" size={16}/>Share</button><button onClick={()=>void copy()}>{copied?"Copied":"Copy link"}</button></div>
 </section></div>
}

function FullBook({items}:{items:ResearchItem[]}){const[expanded,setExpanded]=useState(false);const visible=expanded?items:items.slice(0,10);if(!items.length)return <div className={styles.emptyBlock}><strong>No annual book saved.</strong><span>Missing source data is not treated as an empty portfolio.</span></div>;return <><div className={styles.bookTable}><table><thead><tr><th>Asset</th><th>Type</th><th>Disclosed value</th><th>Mapping</th></tr></thead><tbody>{visible.map(item=><tr key={item.id}><td><strong>{item.ticker??item.name??"Unnamed asset"}</strong>{item.ticker&&item.name?<small>{item.name}</small>:null}</td><td>{item.kind??item.assetType??"Other"}</td><td><strong>{moneyBand(item.valueRange)}</strong></td><td>{item.token?.symbol?<><strong>{item.token.symbol}</strong><small>{item.token.issuer??"Mapped token"}</small></>:<><strong>Disclosure only</strong><small>{item.mappingReason??"No approved mapping"}</small></>}</td></tr>)}</tbody></table></div>{items.length>10?<button className={styles.showAll} onClick={()=>setExpanded(v=>!v)}>{expanded?"Show less":`Show all ${items.length} rows`}</button>:null}</>}

export function ProfileView({id, initialData}:{id:string; initialData?: PersonPortfolioResponse}){
 const tracker=useResource<TrackerPersonResponse>(`/api/tracker-profiles/${encodeURIComponent(id)}`);
 const research=useResource<PersonPortfolioResponse>(`/api/people/${encodeURIComponent(id)}/portfolio`, initialData);
 const legacyNeeded=!research.loading&&!research.data;
 const legacy=useResource<LegacyProfileData>(legacyNeeded?`/api/profiles/${encodeURIComponent(id)}`:null);
 const ui=useUI();
 const wallet=usePrivySolana();
 const vaultDir=useResource<{indexes:PublicVaultDefinition[];publicFundsEnabled:boolean}>("/api/vault-indexes");
 const[shareOpen,setShareOpen]=useState(false),[tab,setTab]=useState<"stocks"|"breakdown"|"moves"|"about">("stocks");
 const[investOpen,setInvestOpen]=useState(false),[investMode,setInvestMode]=useState<"deposit"|"withdraw">("deposit");
 const[vault,setVault]=useState<VaultReadiness|null>(null);
 const[position,setPosition]=useState<IndexSharePosition|null>(null);
 const researchBook=research.data,legacyProfile=legacy.data?.profile??null;
 const trackerPerson=tracker.data?.person??null;
 const vaultIndex=vaultDir.data?.indexes.find(item=>item.bioguideId===id);
 const vaultIndexId=vaultIndex?.indexId??null;
 useEffect(()=>{let alive=true;if(!vaultIndexId){setVault(null);return;}getVaultReadiness(vaultIndexId).then(value=>{if(alive)setVault(value)}).catch(()=>{if(alive)setVault(null)});return()=>{alive=false}},[vaultIndexId]);
 useEffect(()=>{let alive=true;if(!vaultIndexId||!wallet.solanaAddress){setPosition(null);return;}getIndexPosition(vaultIndexId,wallet.solanaAddress).then(value=>{if(alive)setPosition(value)}).catch(()=>{if(alive)setPosition(null)});return()=>{alive=false}},[vaultIndexId,wallet.solanaAddress]);
 const loading=!trackerPerson&&!researchBook&&!legacyProfile&&(tracker.loading||research.loading||(legacyNeeded&&legacy.data==null&&legacy.error==null));
 if(loading)return <Skeleton cards={3}/>;
 if(!trackerPerson&&!researchBook&&!legacyProfile&&tracker.error&&research.error&&legacy.error)return <PageError error={research.error} retry={()=>{tracker.reload();research.reload();legacy.reload()}}/>;
 if(!trackerPerson&&!researchBook&&!legacyProfile)return <div className={styles.emptyPage}><strong>Portfolio not found.</strong><Link href="/">Back to Explore</Link></div>;
 const person=researchBook?.person;const name=trackerPerson?.name??person?.name??legacyProfile!.name;const image=trackerPerson?.image??person?.image??legacyProfile?.imageUrl??portraitFor(slugifyPerson(name));const context=trackerPerson?[trackerPerson.title,trackerPerson.state].filter(Boolean).join(" · ")||"Public disclosure record":person?personContext(person):legacyProfile!.title;const indexName=researchBook?.indexName||researchBook?.publishedIndex?.indexName||legacyProfile?.index?.name||`${name} portfolio`;
 const trackerBook=trackerPerson?trackerHoldings(trackerPerson):[];
 const indexStocks=researchBook?.publishedIndex?.constituents?.length?researchAllocation(researchBook):[];
 const holdings=trackerBook.length?trackerBook:(indexStocks.length?indexStocks:(legacyProfile?.portfolio?.length?legacyHoldings(legacyProfile):researchBook?researchHoldings(researchBook):[]));
 const allocation=trackerBook.filter(item=>item.weightPct!=null);
 const fmpAllocation=researchBook?.publishedIndex?.constituents?.length?researchAllocation(researchBook):legacyProfile?holdings.filter(item=>item.weightPct!=null):[];
 const overviewHoldings=allocation.length?allocation:fmpAllocation.length?fmpAllocation:holdings;
 const trackerMoves=trackerPerson?trackerActivity(trackerPerson):[];
 const activity=trackerMoves.length?trackerMoves:(researchBook?.activity?.length?researchActivity(researchBook):legacyActivity(legacy.data?.trades??[]));const snapshot=researchBook?[...researchBook.snapshots].sort((a,b)=>(b.referenceDate??"").localeCompare(a.referenceDate??""))[0]:null;const fullItems=snapshot?.items??[];const mappedCount=researchBook?.publishedIndex?.constituents.length??holdings.filter(x=>x.mint).length;const following=ui.deviceFollows.includes(id);const latestFiling=trackerPerson?.asOf??snapshot?.filingDate??snapshot?.referenceDate??activity[0]?.filedDate??null;
 const trackerPoints=trackerPerson?.performance.filter(point=>point.date&&typeof point.value==="number").map(point=>({label:point.date!,equity:point.value!}))??[];
 const curve=trackerPoints.length?trackerPoints:legacyProfile?.curve??[];const historicalReturn=curve.length>1&&curve[0].equity?((curve.at(-1)!.equity-curve[0].equity)/Math.abs(curve[0].equity))*100:null;
 const liveState={vaultAddress:vaultIndex?.vaultAddress,shareMint:vaultIndex?.shareMint,network:vaultIndex?.network,depositsEnabled:vaultIndex?.depositsEnabled,publicFundsEnabled:vaultIndex?.publicFundsEnabled===true};
 const live=Boolean(vaultIndex)&&publicIndexIsLive(liveState);
 const liveStatus=vaultIndex?publicIndexStatus(liveState):null;
 const canCashOut=live&&hasIndexShares(position);
 const resourceReadiness=vaultIndex&&vaultIndexId?vaultReadinessFromIndex(vaultIndexId,{index:{vaultAddress:vaultIndex.vaultAddress,shareMint:vaultIndex.shareMint,network:vaultIndex.network},depositsEnabled:vaultIndex.depositsEnabled,publicFundsEnabled:vaultIndex.publicFundsEnabled===true}):null;
 const flowReadiness=vault??resourceReadiness;

 return <div className={styles.page}>
   <div className={styles.topline}><Link href="/"><Icon name="arrow" size={14} style={{transform:"rotate(180deg)"}}/>Explore</Link><span>Public disclosures · delayed, not live positions</span></div>

   <section className={styles.compactHero}>
     <div className={styles.compactIdentity}>
       <div className={styles.heroPortrait}><Portrait name={name} image={image}/><span className={styles.personNumber}>INSIDERINDEX / {id.slice(-6).toUpperCase()}</span></div>
       <div className={styles.identityCopy}><span className={styles.eyebrow}>{context}</span><h1>{name}</h1><p>{indexName}</p><span className={styles.profileStatus}>{live?"Live":liveStatus??"Research"}</span><div className={styles.compactReturn}>{historicalReturn!=null?<><strong>{historicalReturn>=0?"+":""}{historicalReturn.toFixed(1)}%</strong><span>{PREVIEW_MODE?"design preview · 1Y":"historical model · 1Y"}</span></>:<><strong>{holdings.length||"—"}</strong><span>visible holdings</span></>}</div><div className={styles.heroMeta}><span>{live?"Live":liveStatus??"Research"}</span><i/><span>{latestFiling?`Filed ${shortDate(latestFiling)}`:"Filing date unavailable"}</span><i/><span>{mappedCount||"No"} mapped</span></div>
       <div className={styles.heroActions}><button className={`${styles.followButton} ${following?styles.following:""}`} onClick={()=>ui.toggleDeviceFollow(id)}><Icon name={following?"check":"people"} size={15}/>{following?"Following":"Follow"}</button><button className={styles.shareButton} onClick={()=>setShareOpen(true)}><Icon name="share" size={15}/>Share</button>{live?<><button className={styles.indexButton} onClick={()=>{setInvestMode("deposit");setInvestOpen(true)}}>Invest<Icon name="arrow" size={14}/></button>{canCashOut?<button className={styles.indexButton} onClick={()=>{setInvestMode("withdraw");setInvestOpen(true)}}>Cash out</button>:null}</>:null}</div></div>
     </div>
     <div className={styles.heroChart}><PerformanceGraphic profile={legacyProfile} activity={activity} series={trackerPoints} caption={trackerPerson?"PelosiTracker snapshot as of 2026-09-15 · not a live brokerage account":undefined}/></div>
   </section>

   <div className={styles.tabs} role="tablist">{([['stocks',`Stocks ${holdings.length}`],['breakdown','Breakdown'],['moves',`Moves ${activity.length}`],['about','About']] as const).map(([key,label])=><button key={key} className={tab===key?styles.activeTab:""} onClick={()=>setTab(key)}>{label}</button>)}</div>

   {tab==="breakdown"?<section className={styles.overviewGrid}>
     <div className={styles.allocationPanel}>{allocation.length?<AllocationBreakdown title="Index breakdown" subtitle="Weight by stock" items={allocation.map(h=>({ticker:h.ticker,name:h.name,weight:h.weightPct!}))}/>:null}<div className={styles.compactPanel}><header><div><h2>Top stocks</h2><p>{trackerPerson?"Largest names in the shown book.":allocation.length?"Largest published weights first.":"Latest disclosed names."}</p></div><button onClick={()=>setTab("stocks")}>See all</button></header>{overviewHoldings.length?<div className={styles.compactHoldings}>{overviewHoldings.slice(0,7).map((item)=><div className={styles.compactHolding} key={item.key}><StockIcon ticker={item.ticker}/><div><strong>{item.ticker}</strong><small>{item.name}</small></div><b className={styles.holdingPct}>{fmtWeight(item.weightPct)}</b></div>)}</div>:<div className={styles.emptyBlock}><strong>No stocks published.</strong></div>}</div></div>
     <div className={styles.compactPanel}><header><div><h2>Recent moves</h2><p>Public filings, not live trades.</p></div><button onClick={()=>setTab("moves")}>See all</button></header>{activity.length?<div className={styles.compactMoves}>{activity.slice(0,5).map(item=><div className={styles.compactMove} key={item.id}><StockIcon ticker={item.ticker} size="sm"/><span className={`${styles.moveSide} ${styles[item.side]}`}>{item.side==="buy"?"BUY":item.side==="sell"?"SELL":"FILE"}</span><div><strong>{item.ticker}</strong><small>{shortDate(item.tradeDate)} → filed {shortDate(item.filedDate)}</small></div><b>{item.amount}</b></div>)}</div>:<div className={styles.emptyBlock}><strong>No recent activity saved.</strong></div>}</div>
     <div className={styles.compactTrust}><Icon name="shield" size={18}/><div><strong>Public filings, not a live brokerage account.</strong><span>Source rows stay visible even when a name has no stock token.</span></div><button onClick={()=>setTab("about")}>How it works</button></div>
   </section>:null}

   {tab==="stocks"?<section className={styles.tabSection}><div className={styles.tabHeading}><div><h2>Stocks in the index</h2><p>{trackerPerson?"Shown book as of 2026-09-15. Not a live brokerage account.":"Every disclosed name stays visible."}</p></div></div>{holdings.length?<div className={styles.holdingsGrid}>{holdings.map((item,index)=><article className={styles.holdingCard} key={item.key}><span className={styles.rank}>{String(index+1).padStart(2,"0")}</span><StockIcon ticker={item.ticker}/><div className={styles.holdingName}><strong>{item.ticker}</strong><span>{item.name}</span></div><div className={styles.holdingWeight}><strong>{fmtWeight(item.weightPct)}</strong><span>{item.venue??"Filing only"}</span></div><div className={styles.weightTrack}><i style={{width:item.weightPct!=null?`${Math.max(3,item.weightPct*100)}%`:"0%"}}/></div></article>)}</div>:<div className={styles.emptyBlock}><strong>No stocks are published.</strong></div>}</section>:null}

   {tab==="moves"?<section className={styles.tabSection}><div className={styles.tabHeading}><div><h2>Public moves</h2><p>Information only. These prints do not change the published mix.</p></div><Link href="/feed">Open Feed</Link></div>{!activity.length?<div className={styles.emptyBlock}><strong>No activity is saved.</strong></div>:<div className={styles.movesList}>{activity.map((item,index)=><article className={styles.moveRow} key={item.id}><span className={styles.moveIndex}>{String(index+1).padStart(2,"0")}</span><StockIcon ticker={item.ticker} size="sm"/><span className={`${styles.moveSide} ${styles[item.side]}`}>{item.side==="buy"?"BOUGHT":item.side==="sell"?"SOLD":"FILED"}</span><div className={styles.moveAsset}><strong>{item.ticker}</strong><span>{item.name}</span></div><div className={styles.moveDates}><span><b>Trade</b>{shortDate(item.tradeDate)}</span><span><b>Filed</b>{shortDate(item.filedDate)}</span></div><div className={styles.moveAmount}><strong>{item.amount}</strong>{item.copyHref?<Link href={item.copyHref}>Copy this print</Link>:item.sourceUrl?<FilingLink url={item.sourceUrl}/>:null}</div></article>)}</div>}</section>:null}

   {tab==="about"?<section className={styles.tabSection}><div className={styles.tabHeading}><div><h2>About</h2><p>Source filings live here so the rest of the page stays short.</p></div><Link href="/methodology">Methodology</Link></div>{trackerPerson?<div className={styles.emptyBlock}><strong>Shown book dated {trackerPerson.asOf}.</strong><span>Older annual filings are listed below when saved.</span></div>:null}{researchBook?<FullBook items={fullItems}/>:<div className={styles.emptyBlock}><strong>Annual filing table isn&apos;t connected on this profile.</strong></div>}</section>:null}

   <div className={`${styles.mobileBar} ${live?styles.liveBar:""}`}><button className={following?styles.following:""} onClick={()=>ui.toggleDeviceFollow(id)}>{following?"Following":"Follow"}</button>{live?<>{canCashOut?<button onClick={()=>{setInvestMode("withdraw");setInvestOpen(true)}}>Cash out</button>:null}<button onClick={()=>{setInvestMode("deposit");setInvestOpen(true)}}>Invest</button></>:<button onClick={()=>setShareOpen(true)}>Share</button>}</div>
   <ShareSheet open={shareOpen} onClose={()=>setShareOpen(false)} name={name} indexName={indexName} image={image} profile={legacyProfile} holdings={holdings}/>
   {live&&vaultIndexId?<VaultFlow open={investOpen} onClose={()=>setInvestOpen(false)} indexId={vaultIndexId} indexName={indexName} readiness={flowReadiness} mode={investMode} position={position}/>:null}
 </div>
}
