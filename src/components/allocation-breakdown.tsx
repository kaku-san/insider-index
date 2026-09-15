"use client";

import { useMemo, useState } from "react";
import { StockIcon } from "./social/shared";

export type AllocationDatum = {
  ticker: string;
  name?: string | null;
  weight: number;
};

const COLORS = [
  "#ff5a36",
  "#7457ff",
  "#16a38c",
  "#f3a33b",
  "#3e7ad9",
  "#d95f9e",
  "#778397",
  "#a48b62",
];

export function AllocationBreakdown({items,title="Breakdown",subtitle="By asset"}:{items:AllocationDatum[];title?:string;subtitle?:string}){
  const rows=useMemo(()=>{
    const valid=items.filter(x=>Number.isFinite(x.weight)&&x.weight>0).sort((a,b)=>b.weight-a.weight);
    const total=valid.reduce((sum,x)=>sum+x.weight,0)||1;
    const normalized=valid.map(x=>({...x,weight:x.weight/total}));
    if(normalized.length<=8)return normalized;
    const top=normalized.slice(0,7),other=normalized.slice(7).reduce((sum,x)=>sum+x.weight,0);
    return [...top,{ticker:"OTHER",name:`${normalized.length-7} more positions`,weight:other}];
  },[items]);
  const [active,setActive]=useState(0);
  const selected=rows[Math.min(active,Math.max(0,rows.length-1))];
  if(!rows.length)return null;
  return <section className="allocation-breakdown">
    <div className="allocation-head"><div><span>{subtitle}</span><h3>{title}</h3></div><strong>{rows.length===1&&rows[0].ticker==="OTHER"?items.length:items.length} positions</strong></div>
    <div className="allocation-strip" role="img" aria-label={rows.map(x=>`${x.ticker} ${(x.weight*100).toFixed(1)}%`).join(", ")}>
      {rows.map((row,index)=><button key={`${row.ticker}-${index}`} type="button" aria-label={`${row.ticker} ${(row.weight*100).toFixed(1)}%`} className={index===active?"active":""} style={{width:`${row.weight*100}%`,background:COLORS[index%COLORS.length]}} onMouseEnter={()=>setActive(index)} onFocus={()=>setActive(index)} onClick={()=>setActive(index)}/>) }
    </div>
    {selected?<div className="allocation-focus"><StockIcon ticker={selected.ticker}/><div><strong>{selected.ticker}</strong><span>{selected.name||"Portfolio position"}</span></div><b>{(selected.weight*100).toFixed(selected.weight>=.1?1:2)}%</b></div>:null}
    <div className="allocation-legend">{rows.map((row,index)=><button type="button" key={`${row.ticker}-legend-${index}`} className={index===active?"active":""} onMouseEnter={()=>setActive(index)} onFocus={()=>setActive(index)} onClick={()=>setActive(index)}><i style={{background:COLORS[index%COLORS.length]}}/><StockIcon ticker={row.ticker} size="sm"/><span><strong>{row.ticker}</strong><small>{row.name||"Position"}</small></span><b>{(row.weight*100).toFixed(row.weight>=.1?1:2)}%</b></button>)}</div>
  </section>;
}
