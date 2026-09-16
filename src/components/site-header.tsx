"use client";

import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useUI } from "@/components/providers/ui-provider";
import { WalletButton } from "@/components/wallet-button";
import { BrandMark, Icon } from "@/components/social/icon";

const nav = [
  { label: "Explore", href: "/", icon: "grid" },
  { label: "Feed", href: "/feed", icon: "file" },
  { label: "Following", href: "/following", icon: "people" },
  { label: "Positions", href: "/positions", icon: "wallet" },
] as const;

export function SiteHeader() {
  const path = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { query, setQuery, setTheme, theme } = useUI();
  const input = useRef<HTMLInputElement>(null);
  const [mobileSearch, setMobileSearch] = useState(false);
  const urlQuery = searchParams.get("q") ?? "";

  useEffect(() => {
    setQuery(urlQuery);
  }, [setQuery, urlQuery]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (event.key === "/" && !/input|textarea|select/i.test(target.tagName) && !target.isContentEditable) {
        event.preventDefault();
        input.current?.focus();
      }
      if (event.key === "Escape") {
        input.current?.blur();
        setMobileSearch(false);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const active = (href: string) => href === "/" ? path === "/" : path.startsWith(href);
  function submitSearch(event: FormEvent) {
    event.preventDefault();
    const q = query.trim();
    router.push(q ? `/?q=${encodeURIComponent(q)}` : "/");
    setMobileSearch(false);
  }

  return <>
    <header className="consumer-header">
      <div className="consumer-header-inner">
        <Link href="/" className="consumer-brand" aria-label="InsiderIndex home">
          <BrandMark />
          <span>InsiderIndex</span>
        </Link>

        <nav className="consumer-nav" aria-label="Primary navigation">
          {nav.map((item) => <Link key={item.href} href={item.href} className={active(item.href) ? "active" : undefined} aria-current={active(item.href) ? "page" : undefined}>{item.label}</Link>)}
        </nav>

        <form className={`consumer-search ${mobileSearch ? "open" : ""}`} role="search" onSubmit={submitSearch}>
          <Icon name="search" size={16} />
          <input ref={input} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search people" aria-label="Search people" />
          <kbd>/</kbd>
        </form>

        <div className="consumer-header-actions">
          <button type="button" className="consumer-icon-button mobile-search-toggle" aria-label="Search" aria-expanded={mobileSearch} onClick={() => { setMobileSearch((value) => !value); requestAnimationFrame(() => input.current?.focus()); }}><Icon name="search" size={18} /></button>
          <button type="button" className="consumer-icon-button" aria-label="Toggle color theme" onClick={() => setTheme(document.documentElement.classList.contains("dark") ? "light" : "dark")}><Icon name={theme === "dark" ? "sun" : "moon"} size={18} /></button>
          <WalletButton />
        </div>
      </div>
    </header>

    <nav className="consumer-mobile-nav" aria-label="Mobile navigation">
      {nav.map((item) => <Link key={item.href} href={item.href} className={active(item.href) ? "active" : undefined} aria-current={active(item.href) ? "page" : undefined}><Icon name={item.icon} size={20} /><span>{item.label}</span></Link>)}
    </nav>
  </>;
}
