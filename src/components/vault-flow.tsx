"use client";

import { useEffect, useState } from "react";
import { usePrivySolana } from "./providers/privy-provider";
import { WalletConnectSheet } from "./wallet-connect-sheet";
import { Icon } from "./social/icon";
import { errorText } from "@/lib/frontend/api";
import {
  DEPOSIT_PHASES, creditHasRemainingAmount, depositIsEnabled, getOperation, prepareConversion, prepareDeposit,
  prepareNext, prepareWithdrawal, submitReceipts,
  type IndexSharePosition, type ObservedOperation, type PreparedStep, type VaultReadiness,
} from "@/lib/frontend/vault-api";
import styles from "./vault-flow.module.css";
import { PublicCycleFlow } from "./public-cycle-flow";
import { PUBLIC_MAG7 } from "../lib/index-vaults/public-cycle-parse";

type Mode = "deposit" | "withdraw";
type IndexKind = "person" | "theme";
type Screen = "amount" | "prepare" | "approval" | "progress";

function decimalToRaw(text:string,decimals:number,label:string){
  const value=text.trim();
  if(!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value))throw new Error(`Enter a valid ${label} amount.`);
  const [whole,frac=""]=value.split(".");
  if(frac.length>decimals)throw new Error(`${label} supports at most ${decimals} decimal places.`);
  const raw=BigInt(whole)*10n**BigInt(decimals)+BigInt((frac+"0".repeat(decimals)).slice(0,decimals)||"0");
  if(raw<=0n)throw new Error(`Enter a ${label} amount greater than zero.`);
  return raw.toString();
}
function usdcRaw(text:string){return decimalToRaw(text,6,"USDC");}
const phaseNames: Record<string, string> = {
  DRAFT: "Ready",
  AWAITING_SIGNATURE: "Waiting for your approval",
  SUBMITTED: "Submitted",
  INTENT_CONFIRMED: "Confirmed",
  AWAITING_LOCK: "Locking in",
  PRICING: "Pricing",
  AUCTION: "Matching",
  SETTLING: "Settling",
  SHARES_RECEIVED: "Shares received",
  RETURN_PENDING: "Returning unused funds",
  CLEANUP: "Cleanup",
  COMPLETE: "Complete",
  REDEMPTION_CLAIM: "Claiming tokens",
  CLAIM_PENDING: "Claim pending",
  TOKENS_RECEIVED: "Tokens received",
  CONVERTING: "Converting to cash",
  COMPLETE_IN_KIND: "Complete",
  PARTIAL_USDC: "Partial cash out",
  COMPLETE_USDC: "Cashed out",
};
function phaseLabel(phase:string){return phaseNames[phase] ?? phase.toLowerCase().replaceAll("_"," ").replaceAll("-"," ").replace(/^./,m=>m.toUpperCase());}
function rawToDecimal(rawText:string,decimals:number){
  if(!/^(?:0|[1-9]\d*)$/.test(rawText))throw new Error("The share balance is invalid.");
  const padded=rawText.padStart(decimals+1,"0");
  const whole=decimals?padded.slice(0,-decimals):padded;
  const fraction=decimals?padded.slice(-decimals).replace(/0+$/,""):"";
  return fraction?`${whole}.${fraction}`:whole;
}
function withdrawalDecimals(readiness?:VaultReadiness|null,position?:IndexSharePosition|null){
  const decimals=readiness?.identity?.shareDecimals??readiness?.vault?.shareDecimals;
  if(typeof decimals!=="number"||!Number.isInteger(decimals)||decimals<0||decimals>18)throw new Error("The verified share decimals are unavailable.");
  if(position?.shareDecimals!=null&&position.shareDecimals!==decimals)throw new Error("The position and vault share decimals do not match.");
  return decimals;
}

export function VaultFlow({open,onClose,indexId,indexName,readiness,mode="deposit",position,indexKind:_indexKind="person"}:{open:boolean;onClose:()=>void;indexId:string;indexName:string;readiness?:VaultReadiness|null;mode?:Mode;position?:IndexSharePosition|null;indexKind?:IndexKind}){
  const wallet=usePrivySolana();
  const [screen,setScreen]=useState<Screen>("amount");
  const [amount,setAmount]=useState(mode==="deposit"?"1000":"100");
  const [prepared,setPrepared]=useState<PreparedStep|null>(null);
  const [operation,setOperation]=useState<ObservedOperation|null>(null);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState<string|null>(null);
  const [connectOpen,setConnectOpen]=useState(false);
  const [resumeOpen,setResumeOpen]=useState(false);
  // A bookmarked recovery entry remains reachable when new deposits are closed.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(()=>{setResumeOpen(indexId===PUBLIC_MAG7.indexId&&new URL(window.location.href).searchParams.get("nativeCycle")==="resume");},[indexId]);
  function close(){setResumeOpen(false);if(indexId===PUBLIC_MAG7.indexId){const url=new URL(window.location.href);url.searchParams.delete("nativeCycle");window.history.replaceState(window.history.state,"",url);}onClose();}
  // Reset the reusable modal when a new operation opens; derived state cannot preserve this boundary.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(()=>{if(open){setScreen("amount");setPrepared(null);setOperation(null);setError(null);setAmount(mode==="deposit"?"1000":(position?.sharesText??"0"));}},[open,mode,indexId,position?.sharesText]);
  const hasVault=Boolean(readiness?.identity||readiness?.vault);
  const blocked=(readiness?.blockers??[]).length>0 && !depositIsEnabled(readiness) && mode==="deposit";
  const phase=operation?.phase??prepared?.phase??"DRAFT";
  const withdrawBase=["DRAFT","AWAITING_SIGNATURE","SUBMITTED","REDEMPTION_CLAIM","CLAIM_PENDING","TOKENS_RECEIVED"] as const;
  const progressFlow: readonly string[]=mode==="deposit"?DEPOSIT_PHASES:
    phase==="COMPLETE_IN_KIND"?[...withdrawBase,"COMPLETE_IN_KIND"]:
    phase==="PARTIAL_USDC"?[...withdrawBase,"CONVERTING","PARTIAL_USDC"]:
    phase==="CONVERTING"||phase==="COMPLETE_USDC"?[...withdrawBase,"CONVERTING","COMPLETE_USDC"]:
    withdrawBase;
  const title=mode==="deposit"?`Invest in ${indexName}`:`Cash out ${indexName}`;
  const canPrepare=hasVault&&(mode==="deposit"?depositIsEnabled(readiness):readiness?.redeemEnabled===true);
  const txs=prepared?.transactions??[];

  function start(){
    try{
      if(mode==="deposit")usdcRaw(amount);
      else decimalToRaw(amount,withdrawalDecimals(readiness,position),"share");
      setError(null);
      void doPrepare();
    }catch(e){setError(errorText(e));}
  }

  async function doPrepare(){
    if(!canPrepare){setScreen("prepare");return;}
    if(!wallet.authenticated||!wallet.solanaAddress){setConnectOpen(true);return;}
    setBusy(true);setError(null);
    try{
      const network=readiness?.identity?.network??readiness?.vault?.network;
      if(!network)throw new Error("The vault network is unavailable.");
      const key=crypto.randomUUID();
      const step=mode==="deposit"
        ? await prepareDeposit(indexId,{owner:wallet.solanaAddress,amountRaw:usdcRaw(amount),idempotencyKey:key},network)
        : await prepareWithdrawal(indexId,{owner:wallet.solanaAddress,shareAmountRaw:(()=>{const raw=decimalToRaw(amount,withdrawalDecimals(readiness,position),"share");if(position?.sharesRaw&&BigInt(raw)>BigInt(position.sharesRaw))throw new Error("You cannot redeem more shares than this wallet holds.");return raw})(),requestedExitMode:"in-kind",idempotencyKey:key},network);
      setPrepared(step);
      setScreen(step.requires==="user-signature"?"approval":"prepare");
    }catch(e){setError(errorText(e));setScreen("prepare");}finally{setBusy(false)}
  }

  async function approve(){
    if(!prepared||!wallet.solanaAddress)return;
    setBusy(true);setError(null);
    try{
      let observed:ObservedOperation|null=null;
      for(const tx of txs){
        const signature=await wallet.signAndSendTransaction(tx.messageBase64,prepared.network);
        observed=await submitReceipts(prepared.operationId,wallet.solanaAddress,[{stepId:tx.stepId,signature}]);
        setOperation(observed);
        setPrepared(current=>current?{...current,transactions:current.transactions.filter(candidate=>candidate.stepId!==tx.stepId)}:current);
      }
      if(observed){setPrepared(null);setScreen("progress");}
    }catch(e){setError(errorText(e));}finally{setBusy(false)}
  }

  async function refresh(){
    if(!operation&&!prepared)return;setBusy(true);setError(null);try{const observed=await getOperation((operation??prepared)!.operationId);setOperation(observed);}catch(e){setError(errorText(e));}finally{setBusy(false)}
  }
  async function next(){
    if(!wallet.solanaAddress||!operation)return;setBusy(true);setError(null);try{const network=operation.identity?.network??prepared?.network;if(!network)throw new Error("The operation network is unavailable.");const step=await prepareNext(operation.operationId,wallet.solanaAddress,network);setPrepared(step);if(step.requires==="user-signature")setScreen("approval");else await refresh();}catch(e){setError(errorText(e));}finally{setBusy(false)}
  }
  async function convert(){
    if(!wallet.solanaAddress||!operation)return;const ids=(operation.credits??[]).filter(creditHasRemainingAmount).map(c=>c.id);if(!ids.length)return;setBusy(true);try{const network=operation.identity?.network??prepared?.network;if(!network)throw new Error("The operation network is unavailable.");const step=await prepareConversion(operation.operationId,wallet.solanaAddress,ids,network);setPrepared(step);if(step.requires==="user-signature")setScreen("approval");else await refresh();}catch(e){setError(errorText(e));}finally{setBusy(false)}
  }

  if(!open&&!resumeOpen)return null;
  return <><div className={styles.backdrop} onMouseDown={e=>{if(e.currentTarget===e.target)close()}}><aside className={styles.sheet} role="dialog" aria-modal="true" aria-label={title}>
    <header className={styles.top}><div><small>{mode==="deposit"?"INVEST":"CASH OUT"}</small><h2>{indexName}</h2></div><button onClick={close} aria-label="Close"><Icon name="close" size={20}/></button></header>
    <div className={styles.body}>
      {mode === "deposit" ? <div className={styles.notice}><Icon name="shield" size={18}/><p><strong>Alpha software — experimental; you can lose funds.</strong>Review every wallet approval before signing.</p></div> : null}
      {indexId===PUBLIC_MAG7.indexId?<PublicCycleFlow mode={mode} position={position}/>:<>
      {screen==="amount"?<><div className={styles.intro}><h3>{mode==="deposit"?"Invest in one step.":"Cash out."}</h3><p>{mode==="deposit"?"Enter an amount in USDC. You approve in your wallet before anything moves.":"Enter how many shares to cash out. You approve in your wallet before anything moves."}</p></div>
        {mode==="deposit"?<div className={styles.amountWrap}><label>Amount</label><div className={styles.amount}><span>$</span><input value={amount} inputMode="decimal" onChange={e=>setAmount(e.target.value.replace(/[^0-9.]/g,""))}/></div><div className={styles.quick}>{[250,1000,2500,5000].map(v=><button key={v} onClick={()=>setAmount(String(v))}>${v.toLocaleString()}</button>)}</div></div>:<div className={styles.amountWrap}><label>Shares</label><div className={styles.amount}><input value={amount} onChange={e=>setAmount(e.target.value.replace(/[^0-9.]/g,""))}/><span>shares</span></div><div className={styles.quick}>{[25,50,100].map(p=><button key={p} onClick={()=>{try{const decimals=withdrawalDecimals(readiness,position);const percentageRaw=BigInt(position?.sharesRaw??"0")*BigInt(p)/100n;setError(null);setAmount(rawToDecimal(percentageRaw.toString(),decimals))}catch(e){setError(errorText(e))}}}>{p}%</button>)}</div></div>}
        <div className={styles.summary}><div className={styles.row}><span>{mode==="deposit"?"You invest":"You cash out"}</span><strong>{mode==="deposit"?`${amount} USDC`:`${amount} shares`}</strong></div><div className={styles.row}><span>Fees</span><strong>Shown before you approve</strong></div></div>{error?<div className={styles.blockers}>{error}</div>:null}{blocked?<div className={styles.blockers}><strong>Not ready to sign</strong><ul>{(readiness?.blockers??[]).map((x,i)=><li key={i}>{x}</li>)}</ul></div>:null}<div className={styles.notice}><Icon name="shield" size={18}/><p><strong>Nothing moves until you approve.</strong>Connecting a wallet does not invest or cash out.</p></div><div className={styles.cta}><button className={styles.primary} disabled={busy} onClick={start}>{!wallet.authenticated?"Connect to continue":busy?"Preparing…":mode==="deposit"?"Invest":"Cash out"}</button></div></>
      :screen==="prepare"?<><div className={styles.intro}><h3>{prepared?.blockers?.length?"This stopped here.":"Not ready to sign yet."}</h3><p>Nothing was sent. You can go back and try again when investing is open.</p></div><PreparedDetails prepared={prepared}/><div className={styles.blockers}><ul>{(prepared?.blockers?.length?prepared.blockers:readiness?.blockers?.length?readiness.blockers:[error||"This action is not available yet."]).map((x,i)=><li key={i}>{x}</li>)}</ul></div><div className={styles.cta}><button className={styles.secondary} onClick={()=>setScreen("amount")}>Back</button></div></>
      :screen==="approval"?<><div className={styles.intro}><h3>Approve in your wallet.</h3><p>{txs.length} {txs.length===1?"approval":"approvals"} ready. Check the amount before you sign.</p></div><PreparedDetails prepared={prepared}/>{txs.map((tx,i)=><div className={styles.approval} key={tx.stepId}><div className={styles.approvalTop}><span>APPROVAL {i+1} OF {txs.length}</span></div><h4>{phaseLabel(tx.stepId)}</h4></div>)}{error?<div className={styles.blockers}>{error}</div>:null}<div className={styles.cta}><button className={styles.secondary} onClick={()=>setScreen("amount")}>Back</button><button className={styles.primary} disabled={busy||!txs.length||Boolean(prepared?.blockers.length)} onClick={()=>void approve()}>{busy?"Waiting for wallet…":"Approve in wallet"}</button></div></>
      :<><div className={styles.phaseCard}><small>{mode==="deposit"?"INVEST":"CASH OUT"}</small><h3>{phaseLabel(phase)}</h3><p>{phase==="SHARES_RECEIVED"?"Your shares are in. Unused cash may still be coming back.":phase==="TOKENS_RECEIVED"?"The stocks landed in your wallet. Keep them, or convert only these to USDC.":phase.startsWith("COMPLETE")?"Done.":"You can close this and come back. The status is saved."}</p></div><Progress phases={progressFlow} current={phase}/>{error?<div className={styles.blockers}>{error}</div>:null}{mode==="withdraw"&&phase==="TOKENS_RECEIVED"?<div className={styles.choices}><div className={`${styles.exitChoice} ${styles.active}`}><strong>Keep the stocks</strong><span>Finish without selling.</span></div><button className={styles.exitChoice} onClick={()=>void convert()}><strong>Convert to USDC</strong><span>Only the cashed-out amount, after a separate approval.</span></button></div>:null}{mode==="withdraw"&&phase==="TOKENS_RECEIVED"?null:<div className={styles.cta}>{phase.startsWith("COMPLETE")?<button className={styles.primary} onClick={onClose}>Done</button>:<><button className={styles.secondary} disabled={busy} onClick={()=>void refresh()}>Refresh</button><button className={styles.primary} disabled={busy} onClick={()=>void next()}>{busy?"Checking…":"Continue"}</button></>}</div>}</>}
      </>}
    </div><footer className={styles.footer}>Fees and share amounts are shown only when the prepared action supplies them. Index shares and copy trades are different things.</footer>
  </aside></div><WalletConnectSheet open={connectOpen} onClose={()=>setConnectOpen(false)}/></>;
}

function PreparedDetails({prepared}:{prepared:PreparedStep|null}){
  if(!prepared)return null;
  const rows=[
    prepared.estimate?.sharesText? ["Estimated shares",prepared.estimate.sharesText] : null,
    prepared.estimate?.outputSummary?["Estimated output",prepared.estimate.outputSummary]:null,
    prepared.costs?.hostEntryFeeBps!=null?["Host entry fee",`${prepared.costs.hostEntryFeeBps} bps`]:null,
    prepared.costs?.hostExitFeeBps!=null?["Host exit fee",`${prepared.costs.hostExitFeeBps} bps`]:null,
    prepared.costs?.quotedSwapCost?["Quoted swap cost",prepared.costs.quotedSwapCost]:null,
    ...(prepared.constraints??[]).map(constraint=>[constraint.label,constraint.value] as const),
  ].filter((row):row is readonly [string,string]=>Boolean(row));
  if(!rows.length)return null;
  return <div className={styles.summary} aria-label="Prepared estimates and constraints">{rows.map(([label,value])=><div className={styles.row} key={label}><span>{label}</span><strong>{value}</strong></div>)}</div>;
}

function Progress({phases,current}:{phases:readonly string[];current:string}){const ci=Math.max(0,phases.indexOf(current));const compact=phases.filter((_,i)=>i===0||i===phases.length-1||Math.abs(i-ci)<=1||[3,6,8].includes(i));return <div className={styles.progress}>{compact.map(p=>{const i=phases.indexOf(p);const state=i<ci?styles.done:i===ci?styles.current:"";return <div key={p} className={`${styles.step} ${state}`}><span className={styles.dot}/><div><strong>{phaseLabel(p)}</strong><small>{i<ci?"Confirmed":i===ci?"Current stage":"Upcoming"}</small></div></div>})}</div>}
