// DESIGN FIXTURES ONLY. These are invented examples, NOT actual disclosures,
// returns, recommendations, account balances, or statements about these people.
import type {FomoProfile,CopySignal,PoliticalParty} from "@/lib/disclosures/types";
const people: [string,string,PoliticalParty|null,number,string][]=[
 ["nancy-pelosi","Nancy Pelosi","Democratic",.264,"NVDA"],
 ["dan-crenshaw","Dan Crenshaw","Republican",.187,"MSFT"],
 ["jensen-huang","Jensen Huang",null,.318,"NVDA"],
 ["josh-gottheimer","Josh Gottheimer","Democratic",.142,"AAPL"],
 ["marjorie-taylor-greene","Marjorie Taylor Greene","Republican",-.042,"AMZN"],
 ["ro-khanna","Ro Khanna","Democratic",.219,"GOOGL"],
 ["michael-mccaul","Michael McCaul","Republican",.083,"AAPL"],
 ["satya-nadella","Satya Nadella",null,.167,"MSFT"]
];
export const previewProfiles:FomoProfile[]=people.map(([id,name,party,pnl,ticker],i)=>{
 const holdingTickers=Array.from(new Set([ticker,"NVDA","MSFT","AAPL","GOOGL"])).slice(0,4);
 const weights=[.4,.28,.2,.12];
 const portfolio=holdingTickers.map((t,j)=>({ticker:t,xstockSymbol:`${t}x`,xstockMint:`preview-only-${t}`,weightPct:weights[j],valueUsd:weights[j]*100000,copyEligible:true}));
 return {id,name,handle:`@${id.replaceAll("-","")}`,kind:party?"politician":"insider",title:party?"Congress · example profile":"Executive · example profile",party,chamber:null,state:null,cikOrBioguide:"PREVIEW-NOT-A-RECORD",imageUrl:`/portraits/${id}.jpg`,followers: [18420,8640,14280,5910,4280,6210,3800,9140][i],lastSignalAt:"2026-09-10T16:00:00Z",insights:[{horizon:"24h",returnPct:pnl/31,trades:1,volumeUsd:12000,hitRate:.65},{horizon:"30d",returnPct:pnl*.42,trades:7+i,volumeUsd:420000,hitRate:.71},{horizon:"90d",returnPct:pnl,trades:21+i,volumeUsd:1800000,hitRate:.73}],hitRate90d:.73,copiedPnl90d:pnl,portfolio,curve:Array.from({length:25},(_,j)=>({label:`Day ${j*4}`,equity:10000*(1+pnl*j/24+Math.sin(j*1.7)*.012)})),latestSignalId:`preview-${i+1}`,latestEligibleSignalId:`preview-${i+1}`,index:{id:`idx-${id}`,profileId:id,name:`${name.split(" ").at(-1)} Index`,imageUrl:`/portraits/${id}.jpg`,kind:party?"politician":"insider",party,constituents:portfolio.map(p=>({ticker:p.ticker,xstockSymbol:p.xstockSymbol!,mint:p.xstockMint!,weightPct:p.weightPct,valueUsd:p.valueUsd})),lastDisclosureId:`preview-${i+1}`,lastDisclosureAt:"2026-09-10T16:00:00Z"}};
});
export const previewSignals:CopySignal[]=previewProfiles.map((p,i)=>({id:`preview-${i+1}`,accessionNumber:"PREVIEW-NOT-A-REAL-FILING",ticker:people[i][4],issuerName:{NVDA:"NVIDIA",MSFT:"Microsoft",AAPL:"Apple",AMZN:"Amazon",GOOGL:"Alphabet"}[people[i][4]]??"Example company",insiderName:p.name,insiderTitle:p.title,insiderCik:"PREVIEW",transactionCode:i===2?"S":"P",transactionDate:"2026-08-24",filedAt:`2026-09-${String(10-i).padStart(2,"0")}T16:00:00Z`,sharesAmount:100,pricePerShare:null,transactionValue:p.kind==="insider"?150000:null,sharesOwnedAfter:null,is10b51:i===2,source:p.kind==="politician"?"mock-congress":"mock-form4",side:i===2?"sell":"buy",xstockSymbol:`${people[i][4]}x`,xstockMint:`preview-only-${people[i][4]}`,tradeEligible:i!==6,kind:p.kind,profileId:p.id,party:p.party,chamber:null,state:null,amountLow:15000,amountHigh:50000,headline:"Illustrative disclosure — not a real trade",fomoLabel:"Example filing",imageUrl:p.imageUrl}));
export function previewRead(path:string):unknown {
 const url=new URL(path,"https://preview.invalid"),p=url.pathname;
 if(p==="/api/profiles")return {profiles:previewProfiles};
 if(p==="/api/signals"||p==="/api/disclosures")return {signals:previewSignals,disclosures:previewSignals};
 if(p==="/api/indexes")return {count:previewProfiles.length,indexes:previewProfiles.map(x=>x.index),holdings:[]};
 if(p==="/api/follows")return {follows:[]};
 if(p==="/api/positions")return {persistence:"preview",positions:[]};
 if(p.startsWith("/api/profiles/")){const profile=previewProfiles.find(x=>x.id===decodeURIComponent(p.split("/").at(-1)!));if(!profile)throw new Error("No preview profile matches this link.");return {profile,trades:previewSignals.filter(x=>x.profileId===profile.id)};}
 if(p.startsWith("/api/indexes/")){const profile=previewProfiles.find(x=>x.index.id===decodeURIComponent(p.split("/").at(-1)!));if(!profile)throw new Error("No preview index matches this link.");return {index:profile.index,profile,holding:null};}
 if(p.startsWith("/api/disclosures/")){const disclosure=previewSignals.find(x=>x.id===decodeURIComponent(p.split("/").at(-1)!));if(!disclosure)throw new Error("No preview filing matches this link.");return {disclosure};}
 throw new Error("This endpoint is not available in the read-only UI preview.");
}
