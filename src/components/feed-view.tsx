"use client";
import {useEffect,useMemo,useState,useSyncExternalStore} from "react";
import Link from "next/link";
import {useSearchParams} from "next/navigation";
import {useResource} from "@/lib/frontend/use-resource";
import {PREVIEW_MODE} from "@/lib/frontend/api";
import {portraitFor} from "@/lib/frontend/portraits";
import {listFollowedPersonIds, subscribeToPersonFollows} from "@/lib/frontend/watchlist";
import {useUI,type Lane} from "@/components/providers/ui-provider";
import {SignalCard} from "./signal-card";
import {PersonAvatar} from "./person-avatar";
import {Icon} from "./social/icon";
import {PageError,Skeleton,EmptyState,StockIcon} from "./social/shared";
import type {Disclosure,CopySignal} from "@/lib/disclosures/types";
const lanes:[Lane,string,string][]=[["live","Everything","bolt"],["following","Following","people"]];
export function FeedView({initialDisclosures}:{initialDisclosures?:Disclosure[]}={}){const ui=useUI(),params=useSearchParams();
 const disclosuresRes=useResource<{disclosures:Disclosure[]}>("/api/disclosures",initialDisclosures?{disclosures:initialDisclosures}:undefined);
 const [side,setSide]=useState("all"),[savedOnly,setSavedOnly]=useState(false),[sort,setSort]=useState("latest");
 const disclosures=disclosuresRes.data?.disclosures??[];
 const followedIds=useSyncExternalStore(subscribeToPersonFollows, listFollowedPersonIds, () => [] as string[]);
 useEffect(()=>{const view=params.get("view");ui.setLane(view==="following"?"following":"live");const q=params.get("q");if(q!=null)ui.setQuery(q);},[params]);
 const followed=useMemo(()=>new Set(followedIds),[followedIds]);
 const signals=useMemo<CopySignal[]>(()=>disclosures.map(d=>({...d,headline:"",fomoLabel:"",imageUrl:portraitFor(d.profileId)})),[disclosures]);
 const people=useMemo(()=>{const seen=new Map<string,CopySignal>();for(const s of signals)if(!seen.has(s.profileId))seen.set(s.profileId,s);return [...seen.values()];},[signals]);
 const needle=ui.query.toLowerCase().trim();
 const inLane=(s:CopySignal)=>ui.lane==="following"?followed.has(s.profileId):true;
 const visible=signals.filter(s=>inLane(s)&&`${s.insiderName} ${s.ticker} ${s.issuerName} ${s.venueSymbol??""}`.toLowerCase().includes(needle)&&(side==="all"||s.side===side)&&(!savedOnly||ui.saved.includes(s.id))).sort((a,b)=>sort==="latest"?Date.parse(b.filedAt)-Date.parse(a.filedAt):Date.parse(a.filedAt)-Date.parse(b.filedAt));
 const radar=Object.entries(signals.reduce<Record<string,number>>((out,s)=>{out[s.ticker]=(out[s.ticker]??0)+1;return out;},{})).sort((a,b)=>b[1]-a[1]).slice(0,4);
 function chooseLane(lane:Lane){ui.setLane(lane);history.replaceState(null,"",lane==="live"?"/feed":"/feed?view=following");setSavedOnly(false);}
 function clearFilters(){ui.setQuery("");setSide("all");setSavedOnly(false);}
 if(disclosuresRes.error&&!disclosures.length)return <PageError error={disclosuresRes.error} retry={disclosuresRes.reload}/>;
 if(disclosuresRes.loading&&!disclosures.length)return <Skeleton cards={5}/>;
 return <div className="discover-page"><div className="page-intro"><div><span className="eyebrow"><span className="tiny-star">✳</span> THE RAW TAPE. INDEXES ARE BUILT FROM THIS.</span><h1>Every filing, in order<span className="accent-dot">.</span></h1><p className="intro-sub">Looking for something to hold? <Link href="/">Start with the indexes</Link>. This is the disclosure-by-disclosure view behind them.</p></div><span className="outlined-pill intro-pill"><Icon name="file" size={14}/>{signals.length} {PREVIEW_MODE?"example":"public"} filings</span></div>
 {people.length?<section className="main-characters"><div className="section-heading"><h2><Icon name="people" size={19}/>Who’s filing</h2><span>Public profiles. Not endorsements.</span></div><div className="filtered-profile-list">{people.map(p=><Link key={p.profileId} href={`/p/${encodeURIComponent(p.profileId)}`}><PersonAvatar name={p.insiderName} imageUrl={p.imageUrl} size="sm"/>{p.insiderName.split(" ").at(-1)}</Link>)}</div></section>:null}
 <div className="discovery-layout"><div className="feed-column"><section id="filing-feed" className="filing-feed"><div className="section-heading feed-heading"><div><h2>{ui.lane==="following"?"Your people. Their filings.":"The paper trail"}<span className="heading-dot"/></h2><p>Fresh disclosures. Not live trades. There’s a difference.</p></div><button className="icon-button" aria-label="Refresh filings" onClick={disclosuresRes.reload}><Icon name="refresh" size={17}/></button></div><div className="lane-tabs" aria-label="Feed views">{lanes.map(([lane,label,icon])=><button key={lane} className={`${ui.lane===lane?"selected":""} ${lane}`} aria-pressed={ui.lane===lane} onClick={()=>chooseLane(lane)}>{ui.lane===lane?<Icon name={icon} size={14}/>:null}{label}{lane==="following"&&followed.size>0?<span className="tab-count">{followed.size}</span>:null}</button>)}</div><div className="mobile-search"><Icon name="search" size={17}/><input aria-label="Search the feed" value={ui.query} onChange={e=>ui.setQuery(e.target.value)} placeholder="Search people or tickers…"/>{ui.query?<button aria-label="Clear search" onClick={()=>ui.setQuery("")}><Icon name="close" size={15}/></button>:null}</div>
 {ui.query?<div className="search-summary">Results for <strong>“{ui.query}”</strong><button onClick={()=>ui.setQuery("")} aria-label="Clear search"><Icon name="close" size={14}/></button></div>:null}
 <div className="feed-tools"><div className="segmented-control compact" role="group" aria-label="Disclosure side">{["all","buy","sell"].map(s=><button key={s} aria-pressed={side===s} className={side===s?"selected":""} onClick={()=>setSide(s)}>{s==="all"?"All filings":s==="buy"?"Buys":"Sells"}</button>)}</div><div className="feed-tool-right"><button className={`icon-button ${savedOnly?"is-saved":""}`} aria-label="Show saved filings" aria-pressed={savedOnly} onClick={()=>setSavedOnly(!savedOnly)}><Icon name="bookmark" size={16}/></button><select aria-label="Sort filings" value={sort} onChange={e=>setSort(e.target.value)}><option value="latest">Newest first</option><option value="oldest">Oldest first</option></select></div></div>
 <div className="signal-list">{visible.map(s=><SignalCard signal={s} key={s.id}/>)}</div>
 {visible.length===0?<EmptyState title={ui.lane==="following"&&!followed.size?"You’re not watching anyone yet.":"No filings match. Yet."} description={ui.lane==="following"&&!followed.size?"Open a profile and add them to your watchlist. Their public filings will land right here, and their next buy in a name with a Solana mint is one tap to copy.":"Try another ticker or filter. We won’t invent a filing."} action={ui.lane==="following"&&!followed.size?"See who’s filing":"Clear filters"} onAction={()=>{clearFilters();if(ui.lane==="following"&&!followed.size)chooseLane("live");}}/>:null}
 </section><div className="caught-up"><Icon name="check" size={15}/>{visible.length>0?"You’re up to date with this tape.":"Only public records. Always your call."}</div></div>
 <aside className="discovery-rail"><section className="rail-card"><div className="rail-heading"><h3><Icon name="eye" size={18}/>On the radar</h3><span>Filings</span></div><p className="rail-subtitle">Most mentioned in this tape</p><div className="radar-list">{radar.map(([ticker,count],i)=><button key={ticker} onClick={()=>{chooseLane("live");ui.setQuery(ticker);}}><span className="radar-rank">{i+1}</span><StockIcon ticker={ticker} size="sm"/><strong>{ticker}</strong><span>{count} filing{count===1?"":"s"}</span><Icon name="up" size={14}/></button>)}</div></section><section className="rail-note"><span className="note-pin"/><span className="mini-label">FEED VS. INDEX</span><h3>This is the tape.<br/>Indexes are the summary.</h3><p>One filing is something to copy. Many filers buying the same names is an index. <Link href="/">Back to indexes</Link>.</p></section><div className="rail-fineprint"><Icon name="info" size={15}/><p>{PREVIEW_MODE?"All filings shown here are synthetic design examples. Portraits identify the example profiles, not actual activity.":"Disclosures arrive after the original trades. Historical returns are not forecasts. Check the record before making a move."}</p></div></aside></div></div>;
}
