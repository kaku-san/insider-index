"use client";
import { useEffect, useRef } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useUI, type Lane, type Theme } from "@/components/providers/ui-provider";
import { WalletButton } from "@/components/wallet-button";
import { Icon, BrandMark } from "@/components/social/icon";

const nav: { label: string; short: string; icon: string; view: Lane | null; href: string }[] = [
  { label: "Indexes", short: "Indexes", icon: "grid", view: null, href: "/" },
  { label: "Disclosure feed", short: "Feed", icon: "bolt", view: "live", href: "/feed" },
  { label: "Following", short: "Following", icon: "people", view: "following", href: "/feed?view=following" },
  { label: "My positions", short: "Positions", icon: "wallet", view: null, href: "/positions" },
];
function crumb(path: string) {
  return path === "/" ? "The index desk" : path === "/feed" ? "Disclosure feed" : path.startsWith("/p/") ? "Public record" : path.startsWith("/indexes/") ? "Index research" : path.startsWith("/positions") ? "My positions" : path.startsWith("/trade/") ? "Copy one trade" : "Source filing";
}

export function SiteHeader() {
  const ui = useUI(), path = usePathname(), router = useRouter(), input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (event.key === "/" && !event.metaKey && !event.ctrlKey && !event.altKey && !/input|textarea|select/i.test(target.tagName) && !target.isContentEditable) {
        const search = path === "/" ? document.querySelector<HTMLInputElement>("#directory input[type=search]") : input.current;
        if (search) { event.preventDefault(); search.focus(); }
      }
      if (event.key === "Escape") input.current?.blur();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [path]);
  const active = (item: typeof nav[number]) => item.href === "/" ? path === "/" : item.href === "/positions" ? path.startsWith("/positions") : path === "/feed" && ui.lane === item.view;
  const navigate = (item: typeof nav[number]) => { if (item.view) ui.setLane(item.view); ui.setQuery(""); };

  return <>
    <aside className="sidebar">
      <Link href="/" className="brand" aria-label="Stocklana home"><BrandMark /><span>stocklana<span className="brand-dot">.</span></span></Link>
      <div className="sidebar-heading">Your seat at the table.</div>
      <nav className="desktop-nav" aria-label="Primary navigation">{nav.map((item) => <Link key={item.label} href={item.href} title={item.label} onClick={() => navigate(item)} className={`nav-item ${active(item) ? "active" : ""}`} aria-current={active(item) ? "page" : undefined}><Icon name={item.icon} /><span>{item.label}</span>{active(item) && <span className="nav-dot" />}</Link>)}</nav>
      <div className="sidebar-bottom">
        <div className="sidebar-sticker"><Icon name="landmark" size={28} /><p>Everyone is<br /><strong>an insider.</strong></p><span>Public records. Personal decisions.</span></div>
        <div className="theme-switch" role="group" aria-label="Color theme">{([["light", "sun"], ["dark", "moon"], ["system", "monitor"]] as [Theme, string][]).map(([theme, icon]) => <button key={theme} onClick={() => ui.setTheme(theme)} aria-pressed={ui.theme === theme} aria-label={`Use ${theme} theme`} className={ui.theme === theme ? "selected" : ""}><Icon name={icon} size={16} /><span>{theme}</span></button>)}</div>
        <div className="sidebar-foot"><span className="solana-bars">≋</span> Built for Solana</div>
      </div>
    </aside>
    <header className="site-header">
      <div className="header-left"><Link href="/" className="brand mobile-brand" aria-label="Stocklana home"><BrandMark /><span>stocklana.</span></Link><span className="header-breadcrumb">{crumb(path)}</span></div>
      {path === "/feed" ? <form className="header-search" role="search" onSubmit={(event) => { event.preventDefault(); router.replace(`/feed?${ui.lane === "following" ? "view=following&" : ""}q=${encodeURIComponent(ui.query)}`); }}><Icon name="search" size={17} /><input ref={input} value={ui.query} onChange={(event) => ui.setQuery(event.target.value)} placeholder="Search people or tickers…" aria-label="Search people and tickers in the feed" /><kbd>/</kbd></form> : <span className="header-tagline">Less noise. More receipts.</span>}
      <div className="header-actions"><button className="icon-button theme-quick" aria-label={ui.theme === "dark" ? "Switch to light mode" : "Switch to dark mode"} onClick={() => ui.setTheme(document.documentElement.classList.contains("dark") ? "light" : "dark")}><Icon name={ui.theme === "dark" ? "sun" : "moon"} /></button><WalletButton /></div>
    </header>
    <nav className="mobile-nav" aria-label="Mobile navigation">{nav.map((item) => <Link key={item.label} href={item.href} onClick={() => navigate(item)} className={active(item) ? "active" : ""} aria-current={active(item) ? "page" : undefined}><Icon name={item.icon} size={21} /><span>{item.short}</span></Link>)}</nav>
  </>;
}
