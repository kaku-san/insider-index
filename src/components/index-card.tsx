import Link from "next/link";
import {PersonAvatar} from "@/components/person-avatar";
import {Icon} from "@/components/social/icon";
import {CHART_COLORS} from "@/components/portfolio-charts";
import type {PersonIndex} from "@/lib/disclosures/types";
import {isCrowdIndex,readinessSummary,type IndexReadiness} from "@/lib/fomo/index-readiness";
export function indexKindLabel(index:PersonIndex):string{const crowd=isCrowdIndex(index);return index.kind==="politician"?crowd?"Members of Congress":"Congress":crowd?"Company executives":"Executive";}
export function IndexCard({index,readiness,needsRebalance=false}: {index:PersonIndex;readiness?:IndexReadiness;needsRebalance?:boolean}) {
 const crowd=isCrowdIndex(index),href=`/indexes/${encodeURIComponent(index.id)}`,ready=readiness?.ready??true;
 return <article className={`index-card ${ready?"":"is-building"}`}><div className="index-card-header"><PersonAvatar name={index.name} imageUrl={index.imageUrl} size="lg"/><div><span className="mini-label">{crowd?"MANY FILERS. ONE BASKET.":"ONE PERSON. ONE BASKET."}</span><Link href={href}><h3>{index.name}</h3></Link><span className="index-kind">{indexKindLabel(index)}</span></div></div>
 <p>{crowd?"The tradable names these filers bought most, weighted by how many of them bought.":"The tradable names in their disclosed book, weighted by estimated size."}</p>
 <div className="weight-bar" aria-hidden="true">{index.constituents.map((h,i)=><span key={h.ticker} style={{width:`${h.weightPct*100}%`,background:CHART_COLORS[i%CHART_COLORS.length]}}/>)}</div>
 <div className="index-weight-chips">{index.constituents.slice(0,6).map((h,i)=><span key={h.ticker} title={h.venue==="xstock"?"xStock mint · user-signed swap":"Backpack token · user-signed swap"}><i style={{background:CHART_COLORS[i%CHART_COLORS.length]}}/>{h.ticker}{h.venue!=="xstock"?<em className="leg-venue">BP</em>:null}<strong>{(h.weightPct*100).toFixed(0)}%</strong></span>)}{index.constituents.length>6?<span>+{index.constituents.length-6} more</span>:null}</div>
 {readiness?<span className={`readiness-pill ${ready?"ready":"building"}`}><Icon name={ready?"check":"clock"} size={12}/>{ready?readinessSummary(readiness):readiness.need}</span>:null}
 <Link className={`button ${ready?"primary":"secondary"} full-width`} href={href}>{ready?`Buy ${index.name}`:"See what’s missing"}<Icon name="arrow" size={16}/></Link>
 <span className="index-card-caption"><Icon name={needsRebalance?"refresh":"shield"} size={13}/>{needsRebalance?"New weights · review rebalance":"You review and sign every order"}</span></article>;
}
