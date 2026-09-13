import type { CSSProperties } from "react";
const paths: Record<string, string> = {
  compass:"M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm4 5-2.5 5.5L8 16l2.5-5.5L16 8Z",
  people:"M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm13 10v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75",
  grid:"M3 3h7v7H3V3Zm11 0h7v7h-7V3ZM3 14h7v7H3v-7Zm11 0h7v7h-7v-7Z",
  wallet:"M20 8V5a2 2 0 0 0-2-2H5a3 3 0 0 0 0 6h15v11H5a3 3 0 0 1-3-3V6m18 6h-5v5h5m-3-2.5h.01",
  search:"m21 21-5-5M10.5 18a7.5 7.5 0 1 0 0-15 7.5 7.5 0 0 0 0 15Z",
  sun:"M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Zm0-6v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5",
  moon:"M21 12.8A9 9 0 0 1 11.2 3 9 9 0 1 0 21 12.8Z",
  monitor:"M3 4h18v13H3V4Zm5 17h8m-4-4v4",
  arrow:"M5 12h14m-6-6 6 6-6 6", up:"M7 17 17 7M7 7h10v10",
  down:"M7 7 17 17M7 17h10V7",
  bolt:"m13 2-9 12h7l-1 8 10-12h-7l0-8Z",
  shield:"m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Zm-4 9 3 3 5-6",
  check:"m5 12 4 4L19 6", close:"m6 6 12 12M6 18 18 6",
  bell:"M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9Zm-8 12h4",
  chevron:"m9 5 7 7-7 7", copy:"M9 9h12v12H9V9Zm-4 6H3V3h12v2",
  bookmark:"M6 3h12v18l-6-4-6 4V3Z", heart:"M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z",
  share:"M12 16V3m-5 5 5-5 5 5M5 13v8h14v-8", refresh:"M20 7v5h-5M4 17v-5h5m-4-4a8 8 0 0 1 13-4l2 3M4 17l2 3a8 8 0 0 0 13-4",
  landmark:"m3 8 9-5 9 5H3Zm2 3v7m5-7v7m4-7v7m5-7v7M2 21h20",
  clock:"M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 4v5l3 2",
  briefcase:"M3 7h18v14H3V7Zm5 0V3h8v4M3 12c5 4 13 4 18 0m-9 1v3",
  filter:"M3 6h18M6 12h12M9 18h6", info:"M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 8v6m0-10h.01",
  file:"M14 2H4v20h16V8l-6-6Zm0 0v6h6M8 13h8m-8 4h6",
  globe:"M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 0c-5 6-5 12 0 18 5-6 5-12 0-18ZM3 12h18",
  eye:"M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Zm10-3a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z",
  flame:"M12 3c2 6 5 4 5 9 2-1 2-3 2-3 6 13-15 16-15 5 0-4 5-5 8-11Z",
  star:"m12 2 2.5 6.5L21 6l-2.5 6.5L22 17l-7-.5L12 23l-3-6.5-7 .5 3.5-4.5L3 6l6.5 2.5L12 2Z",
  logout:"M9 3H3v18h6m7-14 5 5-5 5m-7-5h12"
};
export function Icon({name, size=20, className="", style}: {name:string;size?:number;className?:string;style?:CSSProperties}) {
 return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className={`icon ${className}`} style={style} aria-hidden="true"><path d={paths[name] ?? paths.star}/></svg>;
}
export function BrandMark() { return <span className="brand-mark" aria-hidden="true"><svg viewBox="0 0 32 32" fill="none"><path d="M22 7H12l-5 9h17l-5 9H9" stroke="currentColor" strokeWidth="4" strokeLinecap="square"/><path d="m18 3 5 4-5 4m-4 10-5 4 5 4" stroke="currentColor" strokeWidth="2.5"/></svg></span>; }
