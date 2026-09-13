"use client";
import { createContext, useContext, useState, useEffect, useCallback, useRef, type ReactNode } from "react";
export type Theme = "light" | "dark" | "system";
export type Lane = "live" | "insiders" | "democrats" | "republicans" | "indexes" | "following";
type UI = {theme:Theme; setTheme:(v:Theme)=>void; query:string; setQuery:(v:string)=>void; lane:Lane;setLane:(v:Lane)=>void; toast:(v:string)=>void; saved:string[];toggleSave:(id:string)=>void;previewFollows:string[];togglePreviewFollow:(id:string)=>void;};
const Context = createContext<UI | null>(null);
export function UIProvider({children}: {children:ReactNode}) {
 const [theme,setThemeState]=useState<Theme>("system"),[query,setQuery]=useState(""),[lane,setLane]=useState<Lane>("live");
 const [saved,setSaved]=useState<string[]>([]),[previewFollows,setPreviewFollows]=useState<string[]>([]),[message,setMessage]=useState("");
 const timer=useRef<ReturnType<typeof setTimeout> | null>(null);
 useEffect(()=>{try { const t=localStorage.getItem("stocklana:theme");if(t==="dark"||t==="light"||t==="system") setThemeState(t);
  const s=JSON.parse(localStorage.getItem("stocklana:saved")||"[]"),f=JSON.parse(localStorage.getItem("stocklana:preview-follows")||"[]");
  if(Array.isArray(s))setSaved(s.filter(x=>typeof x==="string")); if(Array.isArray(f))setPreviewFollows(f.filter(x=>typeof x==="string"));
 }catch{};return ()=>{if(timer.current)clearTimeout(timer.current);};},[]);
 useEffect(()=>{const mq=matchMedia("(prefers-color-scheme: dark)");const apply=()=>{const dark=theme==="dark"||(theme==="system"&&mq.matches);document.documentElement.classList.toggle("dark",dark);document.documentElement.style.colorScheme=dark?"dark":"light";};apply();mq.addEventListener("change",apply);return ()=>mq.removeEventListener("change",apply);},[theme]);
 const setTheme=useCallback((t:Theme)=>{setThemeState(t);try{localStorage.setItem("stocklana:theme",t);}catch{}},[]);
 const toast=useCallback((text:string)=>{setMessage(text);if(timer.current)clearTimeout(timer.current);timer.current=setTimeout(()=>setMessage(""),4200);},[]);
 const toggleSave=(id:string)=>setSaved(old=>{const next=old.includes(id)?old.filter(x=>x!==id):[...old,id];try{localStorage.setItem("stocklana:saved",JSON.stringify(next));}catch{};return next;});
 const togglePreviewFollow=(id:string)=>setPreviewFollows(old=>{const next=old.includes(id)?old.filter(x=>x!==id):[...old,id];try{localStorage.setItem("stocklana:preview-follows",JSON.stringify(next));}catch{};return next;});
 return <Context.Provider value={{theme,setTheme,query,setQuery,lane,setLane,toast,saved,toggleSave,previewFollows,togglePreviewFollow}}>{children}<div className={`toast ${message?"is-visible":""}`} role="status" aria-live="polite">{message}</div></Context.Provider>;
}
export function useUI(){const ui=useContext(Context);if(!ui)throw new Error("UIProvider is missing");return ui;}
