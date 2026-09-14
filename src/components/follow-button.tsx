"use client";
import {useState} from "react";
import {PREVIEW_MODE,writeApi,errorText} from "@/lib/frontend/api";
import {usePrivySolana} from "./providers/privy-provider";
import {useUI} from "./providers/ui-provider";
import {Icon} from "./social/icon";
import type {Follow} from "@/lib/frontend/contracts";
/** Follow = "tell me when they file". Copying is always a separate, signed step. */
export function FollowButton({profileId,follow,onChanged,onError,compact=false}: {profileId:string;follow?:Follow|null;onChanged?:()=>void;onError?:(message:string)=>void;compact?:boolean}) {
 const wallet=usePrivySolana(),ui=useUI(),[busy,setBusy]=useState(false);
 const isFollowing=PREVIEW_MODE?ui.previewFollows.includes(profileId):Boolean(follow);
 async function toggle(){
  if(PREVIEW_MODE){ui.togglePreviewFollow(profileId);ui.toast(isFollowing?"Unfollowed in this preview.":"Following in this preview. Saved on this device.");return;}
  if(!wallet.solanaAddress){try{await wallet.connect();ui.toast("Wallet ready. Tap Follow again to save it.");}catch{ui.toast("Wallet connection failed.");}return;}
  setBusy(true);
  try{await writeApi("/api/follows",{wallet:wallet.solanaAddress,profileId,autoCopy:follow?.autoCopy??false,unfollow:isFollowing});onChanged?.();ui.toast(isFollowing?"Unfollowed.":"Following. Their next filing lands in your feed — you still approve every copy.");}
  catch(e){const message=errorText(e);if(onError)onError(message);else ui.toast(message);}
  finally{setBusy(false);}
 }
 return <button type="button" className={`button ${isFollowing?"secondary":"ink-theme"} ${compact?"compact-button":""}`} disabled={busy} aria-pressed={isFollowing} onClick={()=>void toggle()}><Icon name={isFollowing?"check":"people"} size={15}/>{busy?"Saving…":isFollowing?"Following":!wallet.solanaAddress&&!PREVIEW_MODE?"Connect to follow":"Follow"}</button>;
}
