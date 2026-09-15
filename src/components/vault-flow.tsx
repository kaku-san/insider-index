"use client";

import { useEffect, useMemo, useState } from "react";
import { usePrivySolana } from "./providers/privy-provider";
import { WalletConnectSheet } from "./wallet-connect-sheet";
import { Icon } from "./social/icon";
import { PREVIEW_MODE, errorText } from "@/lib/frontend/api";
import {
  DEPOSIT_PHASES, WITHDRAW_PHASES, getOperation, prepareConversion, prepareDeposit,
  prepareNext, prepareWithdrawal, submitReceipts,
  type IndexSharePosition, type ObservedOperation, type PreparedStep, type VaultReadiness,
} from "@/lib/frontend/vault-api";
import styles from "./vault-flow.module.css";

type Mode = "deposit" | "withdraw";
type Screen = "amount" | "review" | "prepare" | "approval" | "progress";

const demoDeposit=["AWAITING_SIGNATURE","SUBMITTED","INTENT_CONFIRMED","AWAITING_LOCK","PRICING","AUCTION","SETTLING","SHARES_RECEIVED","RETURN_PENDING","CLEANUP","COMPLETE"];
const demoWithdraw=["AWAITING_SIGNATURE","SUBMITTED","REDEMPTION_CLAIM","CLAIM_PENDING","TOKENS_RECEIVED","CONVERTING","COMPLETE_USDC"];

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
function phaseLabel(phase:string){return phase.toLowerCase().replaceAll("_"," ").replaceAll("-"," ").replace(/^./,m=>m.toUpperCase());}

export function VaultFlow({open,onClose,indexId,indexName,readiness,mode="deposit",position}:{open:boolean;onClose:()=>void;indexId:string;indexName:string;readiness?:VaultReadiness|null;mode?:Mode;position?:IndexSharePosition|null}){
  const wallet=usePrivySolana();
  const [screen,setScreen]=useState<Screen>("amount");
  const [amount,setAmount]=useState(mode==="deposit"?"1000":"100");
  const [prepared,setPrepared]=useState<PreparedStep|null>(null);
  const [operation,setOperation]=useState<ObservedOperation|null>(null);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState<string|null>(null);
  const [connectOpen,setConnectOpen]=useState(false);
  const [demoIndex,setDemoIndex]=useState(0);
  useEffect(()=>{if(open){setScreen("amount");setPrepared(null);setOperation(null);setError(null);setDemoIndex(0);setAmount(mode==="deposit"?"1000":(position?.sharesText??"0"));}},[open,mode,indexId,position?.sharesText]);
  const live=Boolean(readiness?.ready||readiness?.depositEnabled);
  const blocked=(readiness?.blockers??[]).length>0 && !live;
  const shareText=position?.sharesText??position?.sharesRaw??"0";
  const phase=PREVIEW_MODE?(operation?.phase??(mode==="deposit"?demoDeposit:demoWithdraw)[demoIndex]):(operation?.phase??prepared?.phase??"DRAFT");
  const withdrawBase=["DRAFT","AWAITING_SIGNATURE","SUBMITTED","REDEMPTION_CLAIM","CLAIM_PENDING","TOKENS_RECEIVED"] as const;
  const progressFlow: readonly string[]=mode==="deposit"?DEPOSIT_PHASES:
    phase==="COMPLETE_IN_KIND"?[...withdrawBase,"COMPLETE_IN_KIND"]:
    phase==="PARTIAL_USDC"?[...withdrawBase,"CONVERTING","PARTIAL_USDC"]:
    phase==="CONVERTING"||phase==="COMPLETE_USDC"?[...withdrawBase,"CONVERTING","COMPLETE_USDC"]:
    withdrawBase;
  const amountNumber=Number(amount)||0;
  const estimatedFee=mode==="deposit"?amountNumber*.0025:0;
  const title=mode==="deposit"?`Invest in ${indexName}`:`Exit ${indexName}`;
  const canPrepare=PREVIEW_MODE||live;
  const txs=prepared?.transactions??[];

  async function doPrepare(){
    if(!wallet.authenticated||!wallet.solanaAddress){setConnectOpen(true);return;}
    if(!canPrepare){setScreen("prepare");return;}
    if(PREVIEW_MODE){setScreen("approval");setPrepared({operationId:`demo-${mode}-nancy`,phase:"AWAITING_SIGNATURE",requires:"user-signature",transactions:[{stepId:mode==="deposit"?"deposit-contribution":"redeem-shares",messageBase64:"DESIGN_PREVIEW"}],blockers:[],costs:{hostEntryFeeBps:25,hostExitFeeBps:0,estimatedOnly:true}});return;}
    setBusy(true);setError(null);
    try{
      const key=crypto.randomUUID();
      const step=mode==="deposit"
        ? await prepareDeposit(indexId,{owner:wallet.solanaAddress,amountRaw:usdcRaw(amount),idempotencyKey:key})
        : await prepareWithdrawal(indexId,{owner:wallet.solanaAddress,shareAmountRaw:(()=>{const raw=decimalToRaw(amount,position?.shareDecimals??6,"share");if(position?.sharesRaw&&BigInt(raw)>BigInt(position.sharesRaw))throw new Error("You cannot redeem more shares than this wallet holds.");return raw})(),requestedExitMode:"in-kind",idempotencyKey:key});
      setPrepared(step);
      if(step.blockers?.length||!step.transactions?.length)setScreen("prepare");else setScreen("approval");
    }catch(e){setError(errorText(e));setScreen("prepare");}finally{setBusy(false)}
  }

  async function approve(){
    if(!prepared||!wallet.solanaAddress)return;
    if(PREVIEW_MODE){
      const step=prepared.transactions[0]?.stepId??"";
      const nextPhase=step==="lock-deposit"?"PRICING":step==="convert-redeemed-credits"?"CONVERTING":"SUBMITTED";
      const phases=mode==="deposit"?demoDeposit:demoWithdraw;
      setDemoIndex(Math.max(0,phases.indexOf(nextPhase)));
      setOperation({operationId:prepared.operationId,kind:mode,phase:nextPhase,complete:false});
      setScreen("progress");return;
    }
    setBusy(true);setError(null);
    try{
      const receipts:{stepId:string;signature:string}[]=[];
      for(const tx of txs){const signature=await wallet.signAndSendTransaction(tx.messageBase64);receipts.push({stepId:tx.stepId,signature});}
      const observed=await submitReceipts(prepared.operationId,wallet.solanaAddress,receipts);setOperation(observed);setScreen("progress");
    }catch(e){setError(errorText(e));}finally{setBusy(false)}
  }

  async function refresh(){
    if(PREVIEW_MODE){
      if(!operation)return;
      const phases=mode==="deposit"?demoDeposit:demoWithdraw;
      const currentIndex=Math.max(0,phases.indexOf(operation.phase));
      if(mode==="deposit"&&operation.phase==="INTENT_CONFIRMED")return; // lock needs a separate user approval
      const n=Math.min(currentIndex+1,phases.length-1);
      setDemoIndex(n);setOperation({...operation,phase:phases[n],complete:phases[n].startsWith("COMPLETE")});return;
    }
    if(!operation&&!prepared)return;setBusy(true);setError(null);try{const observed=await getOperation((operation??prepared)!.operationId);setOperation(observed);}catch(e){setError(errorText(e));}finally{setBusy(false)}
  }
  async function next(){
    if(PREVIEW_MODE){
      if(mode==="deposit"&&operation?.phase==="INTENT_CONFIRMED"){
        setOperation({...operation,phase:"AWAITING_LOCK"});setDemoIndex(demoDeposit.indexOf("AWAITING_LOCK"));
        setPrepared({operationId:operation.operationId,phase:"AWAITING_LOCK",requires:"user-signature",transactions:[{stepId:"lock-deposit",messageBase64:"DESIGN_PREVIEW"}],blockers:[]});setScreen("approval");return;
      }
      await refresh();return;
    }
    if(!wallet.solanaAddress||!operation)return;setBusy(true);setError(null);try{const step=await prepareNext(operation.operationId,wallet.solanaAddress);setPrepared(step);if(step.requires==="user-signature"&&step.transactions.length)setScreen("approval");else await refresh();}catch(e){setError(errorText(e));}finally{setBusy(false)}
  }
  async function convert(){
    if(PREVIEW_MODE){
      if(!operation)return;
      setPrepared({operationId:operation.operationId,phase:"TOKENS_RECEIVED",requires:"user-signature",transactions:[{stepId:"convert-redeemed-credits",messageBase64:"DESIGN_PREVIEW"}],blockers:[],estimate:{outputSummary:"Sell verified redeemed credits only"}});setScreen("approval");return;
    }
    if(!wallet.solanaAddress||!operation)return;const ids=(operation.credits??[]).filter(c=>Number(c.creditedRaw)>Number(c.soldRaw??"0")).map(c=>c.id);if(!ids.length)return;setBusy(true);try{const step=await prepareConversion(operation.operationId,wallet.solanaAddress,ids);setPrepared(step);setScreen("approval");}catch(e){setError(errorText(e));}finally{setBusy(false)}
  }

  if(!open)return null;
  return <><div className={styles.backdrop} onMouseDown={e=>{if(e.currentTarget===e.target)onClose()}}><aside className={styles.sheet} role="dialog" aria-modal="true" aria-label={title}>
    <header className={styles.top}><div><small>{mode==="deposit"?"PERSON INDEX · ENTRY":"PERSON INDEX · EXIT"}</small><h2>{indexName}</h2></div><button onClick={onClose} aria-label="Close"><Icon name="close" size={20}/></button></header>
    <div className={styles.body}>{PREVIEW_MODE?<div className={styles.demo}>Interactive design simulation · no wallet signature, RPC call or transaction is created.</div>:null}
      {screen==="amount"?<><div className={styles.intro}><h3>{mode==="deposit"?"One index. One position.":"Choose how much to exit."}</h3><p>{mode==="deposit"?"You contribute USDC to the native index vault. The vault—not your wallet—handles the underlying stock-token settlement.":"Your shares redeem into the underlying basket first. You can keep those tokens or separately authorize conversion of only the redeemed amounts to USDC."}</p></div>
        {mode==="deposit"?<div className={styles.amountWrap}><label>Amount to invest</label><div className={styles.amount}><span>$</span><input value={amount} inputMode="decimal" onChange={e=>setAmount(e.target.value.replace(/[^0-9.]/g,""))}/></div><div className={styles.quick}>{[250,1000,2500,5000].map(v=><button key={v} onClick={()=>setAmount(String(v))}>${v.toLocaleString()}</button>)}</div></div>:<div className={styles.amountWrap}><label>Shares to redeem</label><div className={styles.amount}><input value={amount} onChange={e=>setAmount(e.target.value.replace(/[^0-9.]/g,""))}/><span>shares</span></div><div className={styles.quick}>{[25,50,100].map(p=><button key={p} onClick={()=>{const decimals=Math.min(position?.shareDecimals??6,6);setAmount(((Number(shareText)||0)*p/100).toFixed(decimals).replace(/\.?0+$/,""))}}>{p}%</button>)}</div></div>}
        <div className={styles.summary}><div className={styles.row}><span>InsiderIndex fee</span><strong>{mode==="deposit"?"0.25% entry":"0% exit"}</strong></div><div className={styles.row}><span>Protocol / network</span><strong>Shown before approval</strong></div><div className={styles.row}><span>Wallet approvals</span><strong>Depends on native steps</strong></div></div><div className={styles.notice}><Icon name="shield" size={18}/><p><strong>Nothing moves on Connect.</strong>Every required investor step is reviewed and approved separately. Keeper-only stages never ask for your signature.</p></div><div className={styles.cta}><button className={styles.primary} onClick={()=>setScreen("review")}>{mode==="deposit"?"Review investment":"Review exit"}</button></div></>
      :screen==="review"?<><div className={styles.intro}><h3>Know what happens next.</h3><p>{mode==="deposit"?"Your contribution may pass through more than one native approval and settlement stage. Shares can arrive before unused contribution cleanup is complete.":"Redeeming shares creates underlying entitlements. A failed token claim is resumable; it must never silently burn again."}</p></div><div className={styles.summary}>{mode==="deposit"?<><div className={styles.row}><span>You contribute</span><strong>{amountNumber.toLocaleString()} USDC</strong></div><div className={styles.row}><span>Host entry fee</span><strong>≈ {estimatedFee.toLocaleString(undefined,{maximumFractionDigits:2})} USDC</strong></div><div className={styles.row}><span>You receive</span><strong>Native index shares</strong></div></>:<><div className={styles.row}><span>You redeem</span><strong>{amount||"0"} shares</strong></div><div className={styles.row}><span>First output</span><strong>Underlying basket</strong></div><div className={styles.row}><span>USDC conversion</span><strong>Optional · separate approval</strong></div></>}</div>{blocked&&!PREVIEW_MODE?<div className={styles.blockers}><strong>Not ready to sign</strong><ul>{(readiness?.blockers??[]).map((x,i)=><li key={i}>{x}</li>)}</ul></div>:null}<div className={styles.cta}><button className={styles.secondary} onClick={()=>setScreen("amount")}>Back</button><button className={styles.primary} disabled={busy} onClick={()=>void doPrepare()}>{wallet.authenticated?(PREVIEW_MODE?"Preview approvals":busy?"Preparing…":"Prepare on-chain action"):"Connect to continue"}</button></div></>
      :screen==="prepare"?<><div className={styles.intro}><h3>{prepared?.blockers?.length?"The vault stopped here.":"This action isn't live yet."}</h3><p>The UI fails closed. A preview or model index never turns into a signable transaction unless the backend returns validated unsigned payloads.</p></div><div className={styles.blockers}><strong>Blockers</strong><ul>{(prepared?.blockers?.length?prepared.blockers:readiness?.blockers?.length?readiness.blockers:[error||"No signable transactions were returned."]).map((x,i)=><li key={i}>{x}</li>)}</ul></div><div className={styles.cta}><button className={styles.secondary} onClick={()=>setScreen("review")}>Back</button></div></>
      :screen==="approval"?<><div className={styles.intro}><h3>Approve only what you reviewed.</h3><p>{txs.length} wallet {txs.length===1?"approval":"approvals"} prepared. The backend binds each payload to this wallet, index, operation and spend limit before it reaches this screen.</p></div>{txs.map((tx,i)=><div className={styles.approval} key={tx.stepId}><div className={styles.approvalTop}><span>APPROVAL {i+1} OF {txs.length}</span><b>{tx.simulation?.ok===false?"SIMULATION FAILED":"VALIDATED PAYLOAD"}</b></div><h4>{phaseLabel(tx.stepId)}</h4><p>{tx.maxDebits?.length?`Maximum debit: ${tx.maxDebits.map(x=>x.amountRaw).join(", ")} raw units.`:"Spend and recipients are validated server-side before signing."}</p></div>)}{error?<div className={styles.blockers}>{error}</div>:null}<div className={styles.cta}><button className={styles.secondary} onClick={()=>setScreen("review")}>Back</button><button className={styles.primary} disabled={busy||!txs.length} onClick={()=>void approve()}>{busy?"Waiting for wallet…":PREVIEW_MODE?"Simulate approval":"Approve in wallet"}</button></div></>
      :<><div className={styles.phaseCard}><small>{mode==="deposit"?"INDEX ENTRY":"INDEX EXIT"}</small><h3>{phaseLabel(phase)}</h3><p>{phase==="SHARES_RECEIVED"?"Your shares are in. Cleanup may still be returning unused contribution assets.":phase==="TOKENS_RECEIVED"?"The native basket is in your wallet. Keep it, or authorize conversion of only these redeemed credits.":phase.startsWith("COMPLETE")?"The operation is reconciled against chain receipts.":"This operation is resumable. Closing this sheet does not cancel native state."}</p></div><Progress phases={progressFlow} current={phase}/>{error?<div className={styles.blockers}>{error}</div>:null}{mode==="withdraw"&&phase==="TOKENS_RECEIVED"?<div className={styles.choices}><button className={`${styles.exitChoice} ${styles.active}`} onClick={()=>PREVIEW_MODE?setOperation({operationId:"demo-withdraw-nancy",kind:"withdraw",phase:"COMPLETE_IN_KIND",complete:true}):void 0}><strong>Keep the basket</strong><span>Finish in-kind. No stock-token sales.</span></button><button className={styles.exitChoice} onClick={()=>void convert()}><strong>Convert redeemed tokens to USDC</strong><span>Fresh Jupiter sales. Only verified credited amounts can be spent.</span></button></div>:null}{mode==="withdraw"&&phase==="TOKENS_RECEIVED"?null:<div className={styles.cta}>{phase.startsWith("COMPLETE")?<button className={styles.primary} onClick={onClose}>Done</button>:<><button className={styles.secondary} disabled={busy} onClick={()=>void refresh()}>{PREVIEW_MODE?"Advance demo":"Refresh status"}</button><button className={styles.primary} disabled={busy} onClick={()=>void next()}>{busy?"Checking…":"Continue safely"}</button></>}</div>}</>}
    </div><footer className={styles.footer}>Entry: 0.25% host fee. Exit: 0% host fee. Protocol, venue, bounty and network costs are separate. Index shares, copy fills and underlying redemption tokens are different objects.</footer>
  </aside></div><WalletConnectSheet open={connectOpen} onClose={()=>setConnectOpen(false)}/></>;
}

function Progress({phases,current}:{phases:readonly string[];current:string}){const ci=Math.max(0,phases.indexOf(current));const compact=phases.filter((_,i)=>i===0||i===phases.length-1||Math.abs(i-ci)<=1||[3,6,8].includes(i));return <div className={styles.progress}>{compact.map(p=>{const i=phases.indexOf(p);const state=i<ci?styles.done:i===ci?styles.current:"";return <div key={p} className={`${styles.step} ${state}`}><span className={styles.dot}/><div><strong>{phaseLabel(p)}</strong><small>{i<ci?"Confirmed":i===ci?"Current stage":"Upcoming"}</small></div></div>})}</div>}
