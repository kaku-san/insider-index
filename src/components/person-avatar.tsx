"use client";
import { useState } from "react";
import { initialsFor } from "@/lib/fomo/portraits";
export function PersonAvatar({name,imageUrl,size="md"}: {name:string;imageUrl?:string|null;size?:"sm"|"md"|"lg"|"xl"}) {
 const [failed,setFailed]=useState(false);
 return <span className={`person-avatar avatar-${size}`}>{imageUrl&&!failed?<img src={imageUrl} alt={name} loading="lazy" onError={()=>setFailed(true)}/>:<span role="img" aria-label={name}>{initialsFor(name)}</span>}</span>;
}
