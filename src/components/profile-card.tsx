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

  return (
    <Card className="border-white/10 bg-white/[0.03]">
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <PersonAvatar name={profile.name} imageUrl={profile.imageUrl} />
            <div>
              <CardTitle className="text-white">
                <Link href={`/p/${profile.id}`} className="hover:underline">
                  {profile.name}
                </Link>
              </CardTitle>
              <p className="text-xs text-zinc-500">
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
      <CardContent className="space-y-3">
        <div className="grid grid-cols-3 gap-2 text-center">
          {(["24h", "30d", "90d"] as const).map((horizon) => {
            const row = insight(horizon);
            return (
              <div key={horizon} className="rounded-lg bg-black/30 p-2">
                <p className="text-[10px] uppercase tracking-wide text-zinc-500">{horizon}</p>
                <p className={row && row.returnPct >= 0 ? "text-emerald-300" : "text-rose-300"}>
                  {formatPct(row?.returnPct)}
                </p>
              </div>
            );
          })}
        </div>
        <p className="text-xs text-zinc-500">
          {profile.index.name} · {profile.index.constituents.length} names · 90d hit{" "}
          {(profile.hitRate90d * 100).toFixed(0)}%
        </p>
        <div className="flex flex-wrap gap-2">
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
