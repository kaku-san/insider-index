"use client";
import Link from "next/link";
import {useState} from "react";
import {Icon} from "./icon";
import type {PoliticalParty} from "@/lib/disclosures/types";
import {companyLogoFor} from "@/lib/frontend/company-logos";
export function PartyBadge({party,kind}: {party:PoliticalParty|null;kind?:string}) {const name=party==="Democratic"?"Democrat":party==="Republican"?"Republican":party??(kind==="insider"?"Executive":"Public filing");return <span className={`party-pill ${party==="Democratic"?"democrat":party==="Republican"?"republican":"executive"}`}><span/>{name}</span>;}
type StockIconProps = {ticker:string;size?:"sm"|"md"|"lg"};
function StockIconSource({ticker,normalized,size}: StockIconProps & {normalized:string}) {
 const source=companyLogoFor(normalized);
 const [failed,setFailed]=useState(false);
 return <span aria-label={`${ticker} company logo`} className={`stock-icon stock-logo stock-${ticker.toLowerCase().replace(/[^a-z0-9-]/g,"-")} stock-size-${size}`}>{!failed?<img src={source} alt="" loading="lazy" onError={()=>setFailed(true)}/>:<b>{ticker==="OTHER"?"+":ticker.slice(0,2)}</b>}</span>;
}
export function StockIcon({ticker,size="md"}: StockIconProps) {
 const normalized=ticker.toUpperCase().replace(/\.L$/i,"").replace(/[^A-Z0-9.-]/g,"");
 return <StockIconSource key={normalized} ticker={ticker} normalized={normalized} size={size}/>;
}
export function PageError({error,retry}: {error:string;retry:()=>void}) {return <section className="empty-state" role="alert"><span className="empty-icon"><Icon name="globe" size={30}/></span><h2>The tape is taking a breather.</h2><p>{error}</p><button className="button primary" onClick={retry}><Icon name="refresh" size={16}/>Try again</button></section>;}
export function Skeleton({cards=3}: {cards?:number}) {return <div className="skeleton-stack" role="status" aria-label="Loading content"><span className="sr-only">Loading…</span>{Array.from({length:cards},(_,i)=><div className="skeleton-card" key={i}><div className="skeleton-circle"/><div className="skeleton-lines"><i/><i/><i/></div></div>)}</div>;}
export function Breadcrumb({label}: {label:string}) {return <Link href="/" className="back-link"><Icon name="arrow" size={16} style={{transform:"rotate(180deg)"}}/>Discover<span>/</span>{label}</Link>;}
export function EmptyState({title,description,action,onAction}: {title:string;description:string;action?:string;onAction?:()=>void}) {return <section className="empty-state"><span className="empty-icon"><Icon name="eye" size={30}/></span><h3>{title}</h3><p>{description}</p>{action&&onAction?<button className="button primary" onClick={onAction}>{action}<Icon name="arrow" size={16}/></button>:null}</section>;}
export function MiniLabel({children}: {children:React.ReactNode}) {return <span className="mini-label">{children}</span>;}
