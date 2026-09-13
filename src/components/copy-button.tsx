import Link from "next/link";
import {Button} from "@/components/ui/button";
import {Icon} from "@/components/social/icon";
export function CopyButton({signalId,enabled,label="Copy print"}: {signalId:string|null;enabled:boolean;label?:string}) {return enabled&&signalId?<Button nativeButton={false} className="button primary" render={<Link href={`/trade/${encodeURIComponent(signalId)}?copy=1`}/>}><Icon name="copy" size={15}/>{label}</Button>:<Button className="button secondary" disabled>Not eligible</Button>;}
