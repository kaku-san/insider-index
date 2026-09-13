import Link from "next/link";
import { CopyButton } from "@/components/copy-button";
import { PersonAvatar } from "@/components/person-avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { FomoProfile } from "@/lib/disclosures/types";
import { formatPct } from "@/lib/format";
import { partyChip } from "@/lib/fomo/party";

export function ProfileCard({ profile }: { profile: FomoProfile }) {
  const insight = (horizon: "24h" | "30d" | "90d") =>
    profile.insights.find((row) => row.horizon === horizon);
  const partyBorder =
    profile.party === "Democratic"
      ? "before:bg-sky-400"
      : profile.party === "Republican"
        ? "before:bg-rose-400"
        : "before:bg-emerald-400";

  return (
    <Card className={`surface-interactive relative before:absolute before:inset-y-0 before:left-0 before:w-1 ${partyBorder}`}>
      <CardHeader className="pt-1">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <Link href={`/p/${profile.id}`} aria-label={`View ${profile.name}'s profile`}>
              <PersonAvatar name={profile.name} imageUrl={profile.imageUrl} size="lg" />
            </Link>
            <div>
              <CardTitle className="text-lg text-white">
                <Link href={`/p/${profile.id}`} className="transition-colors hover:text-emerald-200">
                  {profile.name}
                </Link>
              </CardTitle>
              <p className="mt-0.5 text-xs text-zinc-400">
                {profile.handle} · {profile.title}
              </p>
            </div>
          </div>
          {profile.party ? (
            <span className={`rounded-full px-2 py-0.5 text-[11px] ring-1 ${partyChip(profile.party)}`}>
              {profile.party}
            </span>
          ) : (
            <Badge variant="secondary">Executive</Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-3 gap-1.5 text-center">
          {(["24h", "30d", "90d"] as const).map((horizon) => {
            const row = insight(horizon);
            return (
              <div key={horizon} className="rounded-lg bg-black/25 px-1.5 py-2">
                <p className="text-[10px] uppercase tracking-wide text-zinc-500">{horizon}</p>
                <p className={`mt-0.5 text-sm font-semibold ${row && row.returnPct >= 0 ? "metric-positive" : "metric-negative"}`}>
                  {formatPct(row?.returnPct)}
                </p>
              </div>
            );
          })}
        </div>
        <div className="flex items-center justify-between gap-2 text-xs text-zinc-400">
          <span className="truncate">{profile.index.name}</span>
          <span className="shrink-0">{profile.index.constituents.length} xStocks</span>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <CopyButton
            signalId={profile.latestEligibleSignalId}
            enabled={Boolean(profile.latestEligibleSignalId)}
            label="Copy latest print"
          />
          <Button
            nativeButton={false}
            variant="outline"
            render={<Link href={`/indexes/${profile.index.id}`} />}
          >
            Buy index
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
