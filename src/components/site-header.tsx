"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { WalletButton } from "@/components/wallet-button";
import { cn } from "@/lib/utils";

const LINKS = [
  { href: "/", label: "Discover" },
  { href: "/positions", label: "Positions" },
];

export function SiteHeader() {
  const pathname = usePathname();

  return (
    <header className="sticky top-0 z-30 border-b border-white/10 bg-[#070b12]/80 backdrop-blur-xl">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-2 px-4 py-3 sm:gap-4">
        <Link href="/" className="flex min-w-0 items-center gap-2">
          <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-gradient-to-br from-emerald-300 to-teal-400 text-xs font-black text-[#06231f] shadow-[0_0_22px_rgb(52_211_153_/_0.35)]">
            S/
          </span>
          <div className="min-w-0">
            <p className="text-sm font-semibold tracking-tight text-white">Stocklana</p>
            <p className="hidden text-[11px] text-zinc-400 sm:block">Follow the people moving markets.</p>
          </div>
        </Link>
        <nav aria-label="Primary navigation" className="flex shrink-0 items-center gap-0.5">
          {LINKS.map((link) => {
            const active =
              link.href === "/"
                ? pathname === "/"
                : pathname.startsWith(link.href);
            return (
              <Link
                key={link.href}
                href={link.href}
                className={cn(
                  "rounded-lg px-2 py-1.5 text-xs font-medium transition-colors sm:px-3 sm:text-sm",
                  active
                    ? "bg-white/10 text-white"
                    : "text-zinc-400 hover:bg-white/5 hover:text-white",
                )}
              >
                {link.label}
              </Link>
            );
          })}
        </nav>
        <div className="shrink-0">
          <WalletButton />
        </div>
      </div>
    </header>
  );
}
