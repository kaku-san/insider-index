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
    <div className="space-y-8">
      <section className="relative overflow-hidden rounded-3xl border border-white/10 bg-gradient-to-br from-white/[0.06] via-white/[0.025] to-transparent p-5 sm:p-7">
        <div className="absolute -right-16 -top-16 size-64 rounded-full bg-emerald-300/[0.07] blur-3xl" aria-hidden="true" />
        <div className="relative flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-start gap-4 sm:gap-5">
            <PersonAvatar name={profile.name} imageUrl={profile.imageUrl} size="xl" />
            <div className="min-w-0 pt-1">
              <p className="eyebrow">{profile.kind === "politician" ? "Congress profile" : "Insider profile"}</p>
              <h1 className="mt-1 text-3xl font-semibold tracking-[-0.04em] text-white sm:text-4xl">{profile.name}</h1>
              <p className="mt-2 text-sm text-zinc-300 sm:text-base">
                {profile.title} <span className="text-zinc-600">·</span> {profile.handle}
              </p>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                {profile.party ? (
                  <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ring-1 ${partyChip(profile.party)}`}>
                    {profile.party}
                  </span>
                ) : (
                  <Badge variant="secondary">Executive</Badge>
                )}
                <span className="text-xs text-zinc-500">{profile.followers.toLocaleString()} following this tape</span>
              </div>
            </div>
          </div>
          <div className="grid gap-2 sm:flex sm:flex-wrap">
            <CopyButton
              signalId={profile.latestEligibleSignalId}
              enabled={Boolean(profile.latestEligibleSignalId)}
              label="Copy latest trade"
            />
            <Button nativeButton={false} variant="outline" render={<Link href={`/indexes/${profile.index.id}`} />}>
              Buy {profile.index.name}
            </Button>
            {follow ? (
              <>
                <Button
                  variant={follow.autoCopy ? "default" : "outline"}
                  disabled={busy}
                  onClick={() => void setFollowState({ autoCopy: !follow.autoCopy })}
                >
                  {follow.autoCopy ? "Copy queue on" : "Queue next copy"}
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
      </section>

      <section>
        <div className="mb-3 flex items-end justify-between">
          <div>
            <p className="eyebrow">How this tape performed</p>
            <h2 className="mt-1 text-xl font-semibold tracking-tight text-white">Copy stats</h2>
          </div>
          <span className="text-xs text-zinc-500">Historical</span>
        </div>
        <div className="grid gap-2 sm:grid-cols-3">
          {profile.insights.map((insight) => (
            <Card key={insight.horizon} className="surface">
              <CardHeader className="pt-0">
                <CardTitle className="text-xs font-medium uppercase tracking-[0.14em] text-zinc-500">
                  {insight.horizon} backtest
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className={`text-3xl font-semibold tracking-tight ${insight.returnPct >= 0 ? "metric-positive" : "metric-negative"}`}>
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
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="surface">
          <CardHeader className="pt-0">
            <p className="eyebrow">Tracked basket</p>
            <CardTitle className="mt-1 text-xl text-white">{profile.index.name}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <PortfolioDonut holdings={profile.portfolio} title="Book" />
            <p className="text-xs leading-5 text-zinc-500">
              Weights come from disclosed buys minus sells. The index only holds allowlisted xStocks
              and rebalances when a new Form 4 / PTR posts — you still sign.
            </p>
          </CardContent>
        </Card>
        <Card className="surface">
          <CardHeader className="pt-0">
            <p className="eyebrow">Paper performance</p>
            <CardTitle className="mt-1 text-xl text-white">If you copied the book</CardTitle>
          </CardHeader>
          <CardContent>
            <EquityCurve points={profile.curve} label="90d copy path" />
            <p className="mt-3 text-sm text-zinc-400">
              90d copy PnL {formatPct(profile.copiedPnl90d)}. Historical, not a promise.
            </p>
          </CardContent>
        </Card>
      </div>

      <section>
        <p className="eyebrow">Every print</p>
        <h2 className="mb-4 mt-1 text-2xl font-semibold tracking-tight text-white">Disclosure history</h2>
        <div className="grid gap-3">
          {trades.map((trade) => (
            <SignalCard key={trade.id} signal={trade} />
          ))}
        </div>
      </section>
    </div>
  );
}
