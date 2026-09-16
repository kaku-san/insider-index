"use client";
import Link from "next/link";
import { Icon } from "./social/icon";

/**
 * Legacy route kept only so old links fail safely.
 * The retired /api/indexes/quote + /api/indexes/execute stub MUST NOT be called or signed.
 * Investable person indexes use ConsumerIndex + VaultFlow and the native vault prepare endpoints.
 */
export function IndexTicket({id}:{id:string}){
  return <div className="basket-review"><section className="basket-review-intro"><span className="eyebrow">LEGACY BASKET ROUTE</span><h1>This basket cannot be bought<span className="accent-dot">.</span></h1><p>The old multi-leg basket quote/execute path is retired. InsiderIndex only enables an index investment when a published person index has a verified native vault and its prepare endpoint returns validated unsigned transactions.</p><div className="basket-review-meta"><span className="outlined-pill">{id}</span><span className="outlined-pill">No signing</span><span className="outlined-pill">Fail closed</span></div><div style={{display:"flex",gap:8,marginTop:20}}><Link className="button primary" href="/">Explore people <Icon name="arrow" size={14}/></Link><Link className="button secondary" href="/feed">Copy one eligible move</Link></div></section></div>;
}
