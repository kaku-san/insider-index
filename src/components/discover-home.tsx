"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { IndexCard } from "@/components/index-card";
import { PersonAvatar } from "@/components/person-avatar";
import { ProfileCard } from "@/components/profile-card";
import { SignalCard } from "@/components/signal-card";
import { usePrivySolana } from "@/components/providers/privy-provider";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import type { CopySignal, FomoProfile } from "@/lib/disclosures/types";
import type { Follow } from "@/lib/fomo/follows";
import { formatPct } from "@/lib/format";

type Lane = "live" | "insiders" | "democrats" | "republicans" | "indexes" | "following";

export function DiscoverHome() {
  const wallet = usePrivySolana();
  const [lane, setLane] = useState<Lane>("live");
  const [query, setQuery] = useState("");
  const [signals, setSignals] = useState<CopySignal[]>([]);
  const [profiles, setProfiles] = useState<FomoProfile[]>([]);
  const [follows, setFollows] = useState<Follow[]>([]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const [signalRes, profileRes, followRes] = await Promise.all([
        fetch("/api/signals"),
        fetch("/api/profiles"),
        wallet.solanaAddress
          ? fetch(`/api/follows?wallet=${wallet.solanaAddress}`)
          : Promise.resolve(null),
      ]);
      const signalPayload = (await signalRes.json()) as { signals: CopySignal[] };
      const profilePayload = (await profileRes.json()) as { profiles: FomoProfile[] };
      const followPayload = followRes
        ? ((await followRes.json()) as { follows: Follow[] })
        : { follows: [] };
      if (!cancelled) {
        setSignals(signalPayload.signals ?? []);
        setProfiles(profilePayload.profiles ?? []);
        setFollows(followPayload.follows ?? []);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [wallet.solanaAddress]);

  const followedIds = useMemo(() => new Set(follows.map((row) => row.profileId)), [follows]);
  const autoCopyIds = useMemo(
    () => new Set(follows.filter((row) => row.autoCopy).map((row) => row.profileId)),
    [follows],
  );

  const visibleSignals = useMemo(() => {
    return signals.filter((signal) => {
      if (lane === "insiders" && signal.kind !== "insider") return false;
      if (lane === "democrats" && signal.party !== "Democratic") return false;
      if (lane === "republicans" && signal.party !== "Republican") return false;
      if (lane === "following" && !followedIds.has(signal.profileId)) return false;
      const needle = query.trim().toLowerCase();
      if (!needle) return true;
      return `${signal.headline} ${signal.ticker} ${signal.insiderName}`.toLowerCase().includes(needle);
    });
  }, [lane, query, signals, followedIds]);

  const visibleProfiles = useMemo(() => {
    return profiles.filter((profile) => {
      if (lane === "live") return true;
      if (lane === "insiders") return profile.kind === "insider";
      if (lane === "democrats") return profile.party === "Democratic";
      if (lane === "republicans") return profile.party === "Republican";
      if (lane === "following") return followedIds.has(profile.id);
      return true;
    });
  }, [lane, profiles, followedIds]);

  const hottest = [...profiles].sort((a, b) => b.copiedPnl90d - a.copiedPnl90d).slice(0, 6);
  const autoSignals = visibleSignals.filter((signal) => autoCopyIds.has(signal.profileId)).slice(0, 2);

  return (
    <div className="space-y-8 sm:space-y-10">
      <section className="relative overflow-hidden rounded-3xl border border-white/10 bg-gradient-to-br from-emerald-400/[0.12] via-sky-400/[0.05] to-transparent px-5 py-7 shadow-[0_24px_80px_-36px_rgb(16_185_129_/_0.45)] sm:px-8 sm:py-9">
        <div className="absolute -right-12 -top-16 size-52 rounded-full bg-emerald-300/10 blur-3xl" aria-hidden="true" />
        <div className="relative">
          <div className="mb-4 flex flex-wrap gap-2">
            <Badge variant="outline" className="border-emerald-300/25 bg-emerald-300/10 text-emerald-100">Form 4 + Congress tape</Badge>
            <Badge variant="secondary">Every order is user-signed</Badge>
          </div>
          <p className="eyebrow">The public paper trail, made tradable</p>
          <h1 className="mt-2 max-w-3xl text-4xl font-semibold tracking-[-0.04em] text-white sm:text-5xl">
            See the print.<br className="hidden sm:block" /> Catch the move.
          </h1>
          <p className="mt-4 max-w-2xl text-sm leading-6 text-zinc-300 sm:text-base">
            Follow insiders and Congress, copy one eligible trade, or buy their index. Nothing
            happens until you approve it in your wallet.
          </p>
        </div>
      </section>

      <section>
        <div className="mb-3 flex items-baseline justify-between gap-4">
          <div>
            <p className="eyebrow">People are watching</p>
            <h2 className="mt-1 text-xl font-semibold tracking-tight text-white">Hot on Stocklana</h2>
          </div>
          <span className="shrink-0 text-xs text-zinc-500">90d tape return</span>
        </div>
        <div className="-mx-4 flex snap-x gap-3 overflow-x-auto px-4 pb-2 sm:mx-0 sm:px-0">
        {hottest.map((profile) => (
          <Link
            href={`/p/${profile.id}`}
            key={profile.id}
            className="surface-interactive flex min-w-[238px] snap-start items-center gap-3 rounded-2xl p-3.5 sm:min-w-[250px]"
          >
            <PersonAvatar name={profile.name} imageUrl={profile.imageUrl} size="lg" />
            <div className="min-w-0">
              <p className="truncate font-semibold text-white">{profile.name}</p>
              <p className="mt-0.5 truncate text-xs text-zinc-500">{profile.title}</p>
              <p className={`mt-2 text-sm font-semibold ${profile.copiedPnl90d >= 0 ? "metric-positive" : "metric-negative"}`}>
                {formatPct(profile.copiedPnl90d)}
              </p>
            </div>
          </Link>
        ))}
        </div>
      </section>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="-mx-4 flex gap-1 overflow-x-auto px-4 pb-1 sm:mx-0 sm:px-0">
          {(
            [
              ["live", "Live tape"],
              ["insiders", "Executives"],
              ["democrats", "Democrats"],
              ["republicans", "Republicans"],
              ["indexes", "Indexes"],
              ["following", "Following"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setLane(id)}
              aria-pressed={lane === id}
              className={`shrink-0 rounded-full px-3 py-1.5 text-sm font-medium transition-colors ${
                lane === id ? "bg-white text-black shadow-[0_4px_16px_rgb(255_255_255_/_0.15)]" : "bg-white/5 text-zinc-300 hover:bg-white/10 hover:text-white"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search Pelosi, Huang, NVDA…"
          className="h-10 border-white/10 bg-black/20 sm:max-w-xs"
        />
      </div>

      {autoSignals.length > 0 ? (
        <div className="space-y-2 rounded-2xl border border-amber-400/30 bg-amber-400/5 p-4">
          <p className="text-sm font-medium text-amber-100">Your next-copy queue — review and sign</p>
          {autoSignals.map((signal) => (
            <SignalCard key={`auto-${signal.id}`} signal={signal} />
          ))}
        </div>
      ) : null}

      {lane === "indexes" ? (
        <div>
          <p className="eyebrow">One person, one basket</p>
          <h2 className="mt-1 text-2xl font-semibold tracking-tight text-white">Person indexes</h2>
          <p className="mb-5 mt-2 text-sm text-zinc-400">
            One USDC ticket, many xStocks. The target weights refresh on their next filing; every rebalance still needs your signature.
          </p>
          <div className="grid gap-4 md:grid-cols-2">
            {visibleProfiles
              .filter((profile) => profile.index.constituents.length > 0)
              .map((profile) => (
                <IndexCard key={profile.index.id} index={profile.index} />
              ))}
          </div>
        </div>
      ) : null}

      {lane !== "live" && lane !== "indexes" ? (
        <div>
          <p className="eyebrow">Find a signal source</p>
          <h2 className="mb-4 mt-1 text-2xl font-semibold tracking-tight text-white">Profiles</h2>
          <div className="grid gap-4 md:grid-cols-2">
            {visibleProfiles.map((profile) => (
              <ProfileCard key={profile.id} profile={profile} />
            ))}
          </div>
        </div>
      ) : null}

      <div>
        <div className="mb-4 flex items-end justify-between gap-3">
          <div>
            <p className="eyebrow">{lane === "live" ? "Fresh filings" : "Signal history"}</p>
            <h2 className="mt-1 text-2xl font-semibold tracking-tight text-white">
              {lane === "live" ? "Just disclosed" : "Their tape"}
            </h2>
          </div>
          <span className="mb-1 shrink-0 text-xs text-zinc-500">{visibleSignals.length} prints</span>
        </div>
        <div className="grid gap-3">
          {visibleSignals.map((signal) => (
            <SignalCard key={signal.id} signal={signal} />
          ))}
          {visibleSignals.length === 0 ? (
            <p className="text-sm text-zinc-500">
              {lane === "following"
                ? "Follow a profile to fill this lane."
                : "No matching disclosures."}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
