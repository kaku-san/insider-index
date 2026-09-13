import Link from "next/link";
import { PersonAvatar } from "@/components/person-avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { PersonIndex } from "@/lib/disclosures/types";
import { formatDate } from "@/lib/format";
import { partyChip } from "@/lib/fomo/party";

export function IndexCard({
  index,
  needsRebalance,
}: {
  index: PersonIndex;
  needsRebalance?: boolean;
}) {
  return (
    <Card className="surface-interactive relative overflow-hidden">
      <div className="absolute inset-x-0 top-0 h-20 bg-gradient-to-r from-emerald-400/10 via-sky-400/5 to-transparent" aria-hidden="true" />
      <CardHeader className="relative pt-1">
        <div className="flex items-start gap-3">
          <PersonAvatar name={index.name} imageUrl={index.imageUrl} size="lg" />
          <div className="min-w-0">
            <p className="eyebrow">Tracked basket</p>
            <CardTitle className="mt-1 text-lg text-white">{index.name}</CardTitle>
            <p className="mt-1 text-xs text-zinc-400">
              {index.constituents.length} allowlisted xStocks · one signed ticket
            </p>
          </div>
        </div>
      </CardHeader>
      <CardContent className="relative space-y-4">
        <div className="flex flex-wrap gap-1.5">
          {index.party ? (
            <span className={`rounded-full px-2 py-0.5 text-[11px] ring-1 ${partyChip(index.party)}`}>
              {index.party}
            </span>
          ) : (
            <Badge variant="secondary">Executive book</Badge>
          )}
          {needsRebalance ? (
            <Badge variant="destructive">Rebalance ready</Badge>
          ) : (
            <Badge variant="outline">Rebalances on disclosure</Badge>
          )}
        </div>
        <div className="rounded-xl border border-white/8 bg-black/20 p-3">
          <div className="mb-2 flex items-center justify-between text-[10px] font-medium uppercase tracking-[0.14em] text-zinc-500">
            <span>Current weights</span>
            <span>{index.lastDisclosureAt ? `Filed ${formatDate(index.lastDisclosureAt)}` : "Awaiting disclosure"}</span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {index.constituents.slice(0, 4).map((row) => (
              <span key={row.mint} className="rounded-md bg-white/7 px-2 py-1 text-xs text-zinc-200">
                {row.xstockSymbol} <span className="text-zinc-500">{(row.weightPct * 100).toFixed(0)}%</span>
              </span>
            ))}
          </div>
        </div>
        <Button nativeButton={false} className="w-full" render={<Link href={`/indexes/${index.id}`} />}>
          Buy {index.name}
        </Button>
      </CardContent>
    </Card>
  );
}
