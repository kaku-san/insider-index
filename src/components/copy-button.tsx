import Link from "next/link";
import {Button} from "@/components/ui/button";
import {Icon} from "@/components/social/icon";
import type {Venue} from "@/lib/disclosures/types";
/**
 * Copy action routed by venue. Any name with a Solana mint (xStock first,
 * else the Backpack token) opens the in-app user-signed Jupiter ticket;
 * anything else is honestly "No Solana mint yet".
 */
export function CopyButton({signalId,enabled,label="Copy trade",venue="xstock",compact=false}: {signalId:string|null;enabled:boolean;label?:string;venue?:Venue;compact?:boolean}) {
 const cls=compact?"button primary compact":"button primary";
 if(enabled&&venue!=="none"&&signalId)return <Button nativeButton={false} className={cls} render={<Link href={`/trade/${encodeURIComponent(signalId)}?copy=1`}/>} title={venue==="backpack"?"Routes to the Backpack token on Solana":"Routes to the xStock mint"}><Icon name="copy" size={15}/>{label}</Button>;
 return <Button className={compact?"button secondary compact":"button secondary"} disabled>{venue==="none"?"No Solana mint yet":"Not eligible"}</Button>;
}
