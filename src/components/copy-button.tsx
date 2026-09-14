import Link from "next/link";
import {Button} from "@/components/ui/button";
import {Icon} from "@/components/social/icon";
import type {Venue} from "@/lib/disclosures/types";
/**
 * Copy action routed by venue: xStocks open the in-app user-signed ticket;
 * Backpack names link out to the exchange (we never execute there for you);
 * anything else is honestly "Not tradable yet".
 */
export function CopyButton({signalId,enabled,label="Copy trade",venue="xstock",href=null,compact=false}: {signalId:string|null;enabled:boolean;label?:string;venue?:Venue;href?:string|null;compact?:boolean}) {
 const cls=compact?"button primary compact":"button primary";
 if(enabled&&venue==="backpack"&&href)return <Button nativeButton={false} className={cls} render={<a href={href} target="_blank" rel="noopener noreferrer"/>}><Icon name="up" size={15}/>{label==="Copy trade"?"Trade on Backpack":label}</Button>;
 if(enabled&&venue==="xstock"&&signalId)return <Button nativeButton={false} className={cls} render={<Link href={`/trade/${encodeURIComponent(signalId)}?copy=1`}/>}><Icon name="copy" size={15}/>{label}</Button>;
 return <Button className={compact?"button secondary compact":"button secondary"} disabled>{venue==="none"?"Not tradable yet":"Not eligible"}</Button>;
}
