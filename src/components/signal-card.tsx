"use client";
import {useState} from "react";
import Link from "next/link";
import {CopyButton} from "@/components/copy-button";
import {PersonAvatar} from "@/components/person-avatar";
import {Icon} from "@/components/social/icon";
import {PartyBadge,StockIcon} from "@/components/social/shared";
import {useUI} from "@/components/providers/ui-provider";
import type {CopySignal} from "@/lib/disclosures/types";
import {formatDate,formatUsd,formatUsdRange} from "@/lib/format";
export function SignalCard({signal}: {signal:CopySignal}) {
 const ui=useUI(),[reaction,setReaction]=useState<string|null>(null),isBuy=signal.side==="buy",isSell=signal.side==="sell",mock=signal.source.startsWith("mock"),saved=ui.saved.includes(signal.id);
 const range=signal.amountLow!==null||signal.amountHigh!==null?formatUsdRange(signal.amountLow,signal.amountHigh):formatUsd(signal.transactionValue);
 const days=Math.max(0,Math.round((Date.parse(signal.filedAt)-Date.parse(signal.transactionDate))/86400000));
 async function share(){try{await navigator.clipboard.writeText(`${location.origin}/disclosures/${encodeURIComponent(signal.id)}`);ui.toast("Filing link copied. Bring receipts.");}catch{ui.toast("Open the filing and copy the URL from your browser.");}}
 return <article className="signal-card"><div className="signal-header"><Link href={`/p/${encodeURIComponent(signal.profileId)}`} className="signal-person"><PersonAvatar name={signal.insiderName} imageUrl={signal.imageUrl}/><div><strong>{signal.insiderName}</strong><div className="signal-person-meta"><PartyBadge party={signal.party} kind={signal.kind}/><span>{mock?"Example filing":formatDate(signal.filedAt)}</span></div></div></Link><button className={`icon-button save-button ${saved?"is-saved":""}`} aria-label={saved?`Unsave ${signal.ticker} filing`:`Save ${signal.ticker} filing`} aria-pressed={saved} onClick={()=>{ui.toggleSave(signal.id);ui.toast(saved?"Print removed from saved.":"Print saved on this device.");}}><Icon name="bookmark" size={18}/></button></div>
 <p className="signal-sentence">{mock?<span className="example-prefix">Example:</span>:null} Disclosed a <strong className={isBuy?"positive":isSell?"negative":""}>{isBuy?"buy":isSell?"sell":"transaction"}</strong> in <Link href={`/disclosures/${encodeURIComponent(signal.id)}`}>{signal.ticker}<Icon name="up" size={13}/></Link></p>
 <Link href={`/disclosures/${encodeURIComponent(signal.id)}`} className="trade-receipt"><StockIcon ticker={signal.ticker}/><div className="receipt-asset"><strong>{signal.ticker}<span>{signal.xstockSymbol??"Not allowlisted"}</span></strong><small>{signal.issuerName}</small></div><div className="receipt-amount"><strong>{range}</strong><span className={`side-label ${isBuy?"buy":isSell?"sell":""}`}><Icon name={isBuy?"up":isSell?"down":"file"} size={12}/>{isBuy?"BUY":isSell?"SELL":"OTHER"}</span></div></Link>
 <div className="signal-footnote"><span><Icon name="clock" size={13}/>{Number.isFinite(days)?`${days}d reporting lag`:"Reporting lag unavailable"}</span><span>{signal.kind==="politician"?"Congress PTR":"SEC Form 4"}{signal.is10b51?" · 10b5-1":""}{mock?" · synthetic":""}</span></div>
 <div className="signal-actions"><div className="reactions" aria-label="Your private reaction">{[["eyes","👀"],["spicy","🌶️"]].map(([key,emoji])=><button key={key} className={reaction===key?"reacted":""} aria-pressed={reaction===key} aria-label={`${key} reaction (local only)`} onClick={()=>setReaction(reaction===key?null:key)}>{emoji}<span>{reaction===key?"You":""}</span></button>)}<button onClick={()=>void share()} className="share-button" aria-label={`Share ${signal.ticker} filing`}><Icon name="share" size={16}/></button></div><div className="trade-ctas"><Link className="button secondary" href={`/indexes/idx-${encodeURIComponent(signal.profileId)}`}>Buy index</Link><CopyButton signalId={signal.id} enabled={signal.tradeEligible&&signal.side!=="other"} label="Copy print"/></div></div></article>;
}
