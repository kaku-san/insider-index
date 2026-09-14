// DESIGN FIXTURES ONLY. These are invented examples, NOT actual disclosures,
// returns, recommendations, account balances, or statements about these people.
import type {FomoProfile,CopySignal,PoliticalParty,PortfolioHolding} from "@/lib/disclosures/types";
// The fourth column is a legacy placeholder; no illustrative return is rendered anywhere.
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
export const previewProfiles:FomoProfile[]=people.map(([id,name,party,,ticker],i)=>{
 const holdingTickers=Array.from(new Set([ticker,"NVDA","MSFT","AAPL","GOOGL"])).slice(0,4);
 const weights=[.4,.28,.2,.12];
 const portfolio:PortfolioHolding[]=holdingTickers.map((t,j)=>({ticker:t,issuerName:`${t} (example)`,xstockSymbol:`${t}x`,xstockMint:`preview-only-${t}`,venue:"xstock" as const,venueSymbol:`${t}x`,venueMarket:"swap" as const,venueHref:null,weightPct:weights[j],valueUsd:weights[j]*100000,valueLow:weights[j]*80000,valueHigh:weights[j]*120000,status:"holding" as const,buys:2,sells:0,lastSide:"buy" as const,firstTradeAt:"2026-06-02",lastTradeAt:"2026-08-24",latestDisclosureId:`preview-${i+1}`,latestBuyDisclosureId:`preview-${i+1}`,copyEligible:true}));
 // Preview mode is a labelled design fixture; even here we do not paint a return or a curve.
 return {id,name,handle:`@${id.replaceAll("-","")}`,kind:party?"politician":"insider",title:party?"Congress · example profile":"Executive · example profile",party,chamber:null,state:null,cikOrBioguide:"PREVIEW-NOT-A-RECORD",imageUrl:`/portraits/${id}.jpg`,followers: [18420,8640,14280,5910,4280,6210,3800,9140][i],lastSignalAt:"2026-09-10T16:00:00Z",insights:[{horizon:"24h",returnPct:null,trades:1,volumeUsd:32500,volumeLow:15000,volumeHigh:50000,hitRate:null},{horizon:"30d",returnPct:null,trades:7+i,volumeUsd:420000,volumeLow:300000,volumeHigh:540000,hitRate:null},{horizon:"90d",returnPct:null,trades:21+i,volumeUsd:1800000,volumeLow:1200000,volumeHigh:2400000,hitRate:null}],hitRate90d:null,copiedPnl90d:null,portfolio,curve:[],latestSignalId:`preview-${i+1}`,latestEligibleSignalId:`preview-${i+1}`,index:{id:`idx-${id}`,profileId:id,name:`${name.split(" ").at(-1)} Index`,imageUrl:`/portraits/${id}.jpg`,kind:party?"politician":"insider",party,constituents:portfolio.map(p=>({ticker:p.ticker,xstockSymbol:p.xstockSymbol,mint:p.xstockMint,venue:"xstock" as const,venueSymbol:p.venueSymbol!,venueMarket:"swap" as const,venueHref:null,weightPct:p.weightPct,valueUsd:p.valueUsd})),lastDisclosureId:`preview-${i+1}`,lastDisclosureAt:"2026-09-10T16:00:00Z"}};
});
export const previewSignals:CopySignal[]=previewProfiles.map((p,i)=>({id:`preview-${i+1}`,accessionNumber:"PREVIEW-NOT-A-REAL-FILING",ticker:people[i][4],issuerName:{NVDA:"NVIDIA",MSFT:"Microsoft",AAPL:"Apple",AMZN:"Amazon",GOOGL:"Alphabet"}[people[i][4]]??"Example company",insiderName:p.name,insiderTitle:p.title,insiderCik:"PREVIEW",transactionCode:i===2?"S":"P",transactionDate:"2026-08-24",filedAt:`2026-09-${String(10-i).padStart(2,"0")}T16:00:00Z`,sharesAmount:100,pricePerShare:null,transactionValue:p.kind==="insider"?150000:null,sharesOwnedAfter:null,is10b51:i===2,source:p.kind==="politician"?"mock-congress":"mock-form4",side:i===2?"sell":"buy",xstockSymbol:`${people[i][4]}x`,xstockMint:`preview-only-${people[i][4]}`,venue:(i!==6?"xstock":"none") as "xstock"|"none",venueSymbol:i!==6?`${people[i][4]}x`:null,venueMarket:(i!==6?"swap":null) as "swap"|null,venueHref:null,tradeEligible:i!==6,kind:p.kind,profileId:p.id,party:p.party,chamber:null,state:null,amountLow:15000,amountHigh:50000,headline:"Illustrative disclosure — not a real trade",fomoLabel:"Example filing",imageUrl:p.imageUrl}));
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
