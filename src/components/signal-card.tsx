import Link from "next/link";
import { CopyButton } from "@/components/copy-button";
import { PersonAvatar } from "@/components/person-avatar";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import type { CopySignal } from "@/lib/disclosures/types";
import { formatDate, formatUsd, formatUsdRange } from "@/lib/format";
import { partyChip } from "@/lib/fomo/party";

export function SignalCard({ signal }: { signal: CopySignal }) {
  return (
    <Card className="border-white/10 bg-white/[0.03]">
      <CardContent className="flex flex-col gap-3 pt-1 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <PersonAvatar name={signal.insiderName} imageUrl={signal.imageUrl} />
          <div className="min-w-0">
            <div className="mb-1 flex flex-wrap items-center gap-2">
              <Badge variant={signal.side === "sell" ? "destructive" : "default"}>
                {signal.side === "sell" ? "SELL" : "BUY"}
              </Badge>
              <Badge variant="outline">{signal.kind === "politician" ? "Congress" : "Insider"}</Badge>
              {signal.party ? (
                <span className={`rounded-full px-2 py-0.5 text-[11px] ring-1 ${partyChip(signal.party)}`}>
                  {signal.party}
                </span>
              ) : null}
              <span className="text-[11px] text-zinc-500">{signal.fomoLabel}</span>
            </div>
            <Link href={`/p/${signal.profileId}`} className="text-base font-semibold text-white hover:underline">
              {signal.headline}
            </Link>
            <p className="mt-1 text-sm text-zinc-400">
              {formatUsdRange(signal.amountLow, signal.amountHigh)}
              {signal.xstockSymbol ? ` → ${signal.xstockSymbol}` : ""} · {formatDate(signal.filedAt)}
              {signal.transactionValue ? ` · ${formatUsd(signal.transactionValue)}` : ""}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <CopyButton
            signalId={signal.id}
            enabled={signal.tradeEligible}
            label={signal.side === "sell" ? "Copy sell" : "Copy buy"}
          />
          <Link
            href={`/indexes/idx-${signal.profileId}`}
            className="inline-flex h-7 items-center rounded-lg border border-white/10 px-2.5 text-xs text-zinc-300 hover:bg-white/5"
          >
            Index
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}
