import Link from "next/link";
import { PersonAvatar } from "@/components/person-avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { PersonIndex } from "@/lib/disclosures/types";
import { partyChip } from "@/lib/fomo/party";

export function IndexCard({
  index,
  needsRebalance,
}: {
  index: PersonIndex;
  needsRebalance?: boolean;
}) {
  return (
    <Card className="border-white/10 bg-white/[0.03]">
      <CardHeader>
        <div className="flex items-center gap-3">
          <PersonAvatar name={index.name} imageUrl={index.imageUrl} />
          <div>
            <CardTitle className="text-white">{index.name}</CardTitle>
            <p className="text-xs text-zinc-500">
              Rebalances on each new disclosure · {index.constituents.length} xStocks
            </p>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap gap-1">
          {index.party ? (
            <span className={`rounded-full px-2 py-0.5 text-[11px] ring-1 ${partyChip(index.party)}`}>
              {index.party}
            </span>
          ) : (
            <Badge variant="secondary">Executive book</Badge>
          )}
          {needsRebalance ? <Badge variant="destructive">Needs rebalance</Badge> : null}
        </div>
        <p className="text-sm text-zinc-400">
          {index.constituents
            .slice(0, 4)
            .map((row) => `${row.xstockSymbol} ${(row.weightPct * 100).toFixed(0)}%`)
            .join(" · ")}
        </p>
        <Button nativeButton={false} render={<Link href={`/indexes/${index.id}`} />}>
          Open index
        </Button>
      </CardContent>
    </Card>
  );
}
