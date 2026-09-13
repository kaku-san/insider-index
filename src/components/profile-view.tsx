"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { CopyButton } from "@/components/copy-button";
import { EquityCurve, PortfolioDonut } from "@/components/portfolio-charts";
import { PersonAvatar } from "@/components/person-avatar";
import { SignalCard } from "@/components/signal-card";
import { usePrivySolana } from "@/components/providers/privy-provider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { CopySignal, FomoProfile } from "@/lib/disclosures/types";
import type { Follow } from "@/lib/fomo/follows";
import { formatPct, formatUsd } from "@/lib/format";
import { partyChip } from "@/lib/fomo/party";

export function ProfileView({ id }: { id: string }) {
  const wallet = usePrivySolana();
  const [profile, setProfile] = useState<FomoProfile | null>(null);
  const [trades, setTrades] = useState<CopySignal[]>([]);
  const [follow, setFollow] = useState<Follow | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const [profileRes, followRes] = await Promise.all([
        fetch(`/api/profiles/${id}`),
        wallet.solanaAddress
          ? fetch(`/api/follows?wallet=${wallet.solanaAddress}`)
          : Promise.resolve(null),
      ]);
      if (!profileRes.ok) return;
      const payload = (await profileRes.json()) as {
        profile: FomoProfile;
        trades: CopySignal[];
      };
      const follows = followRes
        ? ((await followRes.json()) as { follows: Follow[] }).follows
        : [];
      if (!cancelled) {
        setProfile(payload.profile);
        setTrades(payload.trades);
        setFollow(follows.find((row) => row.profileId === id) ?? null);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [id, wallet.solanaAddress]);

  async function setFollowState(next: { unfollow?: boolean; autoCopy?: boolean }) {
    if (!wallet.solanaAddress) {
      await wallet.connect();
    }
    const address = wallet.solanaAddress;
    if (!address) return;
    setBusy(true);
    const response = await fetch("/api/follows", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        wallet: address,
        profileId: id,
        autoCopy: next.autoCopy ?? follow?.autoCopy ?? false,
        unfollow: next.unfollow ?? false,
      }),
    });
    const payload = (await response.json()) as { follows?: Follow[] };
    setFollow(payload.follows?.find((row) => row.profileId === id) ?? null);
    setBusy(false);
  }

  if (!profile) {
    return <p className="text-sm text-zinc-500">Loading FOMO profile…</p>;
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-4">
          <PersonAvatar name={profile.name} imageUrl={profile.imageUrl} size="lg" />
          <div>
          <p className="text-xs uppercase tracking-[0.2em] text-emerald-300">
            {profile.kind === "politician" ? "Congress profile" : "Insider profile"}
          </p>
          <h1 className="mt-2 text-3xl font-semibold text-white">{profile.name}</h1>
          <p className="mt-1 text-zinc-400">
            {profile.title} · {profile.handle} · {profile.followers.toLocaleString()} followers
          </p>
          {profile.party ? (
            <span className={`mt-3 inline-flex rounded-full px-2 py-0.5 text-xs ring-1 ${partyChip(profile.party)}`}>
              {profile.party}
            </span>
          ) : (
            <Badge className="mt-3" variant="secondary">
              Executive
            </Badge>
          )}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <CopyButton
            signalId={profile.latestEligibleSignalId}
            enabled={Boolean(profile.latestEligibleSignalId)}
            label="Copy latest trade"
          />
          <Button nativeButton={false} variant="outline" render={<Link href={`/indexes/${profile.index.id}`} />}>
            {profile.index.name}
          </Button>
          {follow ? (
            <>
              <Button
                variant={follow.autoCopy ? "default" : "outline"}
                disabled={busy}
                onClick={() => void setFollowState({ autoCopy: !follow.autoCopy })}
              >
                {follow.autoCopy ? "Auto-copy on" : "Auto-copy next"}
              </Button>
              <Button variant="ghost" disabled={busy} onClick={() => void setFollowState({ unfollow: true })}>
                Unfollow
              </Button>
            </>
          ) : (
            <Button disabled={busy} onClick={() => void setFollowState({ autoCopy: false })}>
              Follow
            </Button>
          )}
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-3">
        {profile.insights.map((insight) => (
          <Card key={insight.horizon} className="border-white/10 bg-white/[0.03]">
            <CardHeader>
              <CardTitle className="text-sm text-zinc-400">{insight.horizon} backtest</CardTitle>
            </CardHeader>
            <CardContent>
              <p className={`text-2xl font-semibold ${insight.returnPct >= 0 ? "text-emerald-300" : "text-rose-300"}`}>
                {formatPct(insight.returnPct)}
              </p>
              <p className="mt-1 text-xs text-zinc-500">
                {insight.trades} trades · {formatUsd(insight.volumeUsd)}
                {insight.hitRate != null ? ` · ${(insight.hitRate * 100).toFixed(0)}% hit` : ""}
              </p>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="border-white/10 bg-white/[0.03]">
          <CardHeader>
            <CardTitle className="text-white">{profile.index.name}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <PortfolioDonut holdings={profile.portfolio} title="Book" />
            <p className="text-xs text-zinc-500">
              Weights come from disclosed buys minus sells. The index only holds allowlisted xStocks
              and rebalances when a new Form 4 / PTR posts — you still sign.
            </p>
          </CardContent>
        </Card>
        <Card className="border-white/10 bg-white/[0.03]">
          <CardHeader>
            <CardTitle className="text-white">If you copied the book</CardTitle>
          </CardHeader>
          <CardContent>
            <EquityCurve points={profile.curve} label="90d copy path" />
            <p className="mt-3 text-sm text-zinc-400">
              90d copy PnL {formatPct(profile.copiedPnl90d)}. Historical, not a promise.
            </p>
          </CardContent>
        </Card>
      </div>

      <div>
        <h2 className="mb-3 text-lg font-medium text-white">Disclosure history</h2>
        <div className="grid gap-3">
          {trades.map((trade) => (
            <SignalCard key={trade.id} signal={trade} />
          ))}
        </div>
      </div>
    </div>
  );
}
