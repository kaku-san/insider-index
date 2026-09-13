"use client";

import { useEffect, useMemo, useState } from "react";
import { IndexCard } from "@/components/index-card";
import { PersonAvatar } from "@/components/person-avatar";
import { ProfileCard } from "@/components/profile-card";
import { SignalCard } from "@/components/signal-card";
import { usePrivySolana } from "@/components/providers/privy-provider";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import type { CopySignal, FomoProfile } from "@/lib/disclosures/types";
import type { Follow } from "@/lib/fomo/follows";

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

  const followedIds = new Set(follows.map((row) => row.profileId));
  const autoCopyIds = new Set(follows.filter((row) => row.autoCopy).map((row) => row.profileId));

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
    <div className="space-y-8">
      <div>
        <div className="mb-2 flex flex-wrap gap-2">
          <Badge variant="outline">Form4 + Congress</Badge>
          <Badge variant="secondary">Copy is user-signed</Badge>
        </div>
        <h1 className="text-3xl font-semibold tracking-tight text-white">
          Copy the tape. Insiders, Democrats, Republicans.
        </h1>
        <p className="mt-2 max-w-2xl text-sm text-zinc-400">
          One-trade copy or a full person index — Pelosi Index, Huang Index, and so on.
          Indexes rebalance when a new disclosure hits. Your wallet still signs. No vaults.
        </p>
      </div>

      <div className="flex gap-2 overflow-x-auto pb-1">
        {hottest.map((profile) => (
          <div
            key={profile.id}
            className="flex min-w-[200px] items-center gap-3 rounded-xl border border-white/10 bg-gradient-to-br from-emerald-400/10 to-transparent p-3"
          >
            <PersonAvatar name={profile.name} imageUrl={profile.imageUrl} />
            <div>
              <p className="text-xs text-zinc-500">Hottest 90d</p>
              <p className="font-medium text-white">{profile.name}</p>
              <p className="text-emerald-300">{(profile.copiedPnl90d * 100).toFixed(1)}%</p>
            </div>
          </div>
        ))}
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap gap-1">
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
              className={`rounded-full px-3 py-1.5 text-sm ${
                lane === id ? "bg-white text-black" : "bg-white/5 text-zinc-300"
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
          className="sm:max-w-xs"
        />
      </div>

      {autoSignals.length > 0 ? (
        <div className="space-y-2 rounded-2xl border border-amber-400/30 bg-amber-400/5 p-4">
          <p className="text-sm font-medium text-amber-100">Auto-copy queue — sign to fill</p>
          {autoSignals.map((signal) => (
            <SignalCard key={`auto-${signal.id}`} signal={signal} />
          ))}
        </div>
      ) : null}

      {lane === "indexes" ? (
        <div>
          <h2 className="mb-3 text-lg font-medium text-white">Person indexes</h2>
          <p className="mb-4 text-sm text-zinc-400">
            One USDC ticket, many xStocks. Weights track their disclosed book and shift when they file again.
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
          <h2 className="mb-3 text-lg font-medium text-white">Profiles</h2>
          <div className="grid gap-4 md:grid-cols-2">
            {visibleProfiles.map((profile) => (
              <ProfileCard key={profile.id} profile={profile} />
            ))}
          </div>
        </div>
      ) : null}

      <div>
        <h2 className="mb-3 text-lg font-medium text-white">
          {lane === "live" ? "Just disclosed" : "Their tape"}
        </h2>
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
