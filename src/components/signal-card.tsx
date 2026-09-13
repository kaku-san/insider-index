import Link from "next/link";
import { CopyButton } from "@/components/copy-button";
import { PersonAvatar } from "@/components/person-avatar";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import type { CopySignal } from "@/lib/disclosures/types";
import { formatDate, formatUsd, formatUsdRange } from "@/lib/format";
import { partyChip } from "@/lib/fomo/party";

export function SignalCard({ signal }: { signal: CopySignal }) {
  const sideIsBuy = signal.side !== "sell";
  const partyBorder =
    signal.party === "Democratic"
      ? "before:bg-sky-400"
      : signal.party === "Republican"
        ? "before:bg-rose-400"
        : "before:bg-emerald-400";

  return (
    <Card className={`surface-interactive relative before:absolute before:inset-y-0 before:left-0 before:w-1 ${partyBorder}`}>
      <CardContent className="flex flex-col gap-4 pt-1 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-start gap-3.5">
          <Link href={`/p/${signal.profileId}`} aria-label={`View ${signal.insiderName}'s profile`}>
            <PersonAvatar name={signal.insiderName} imageUrl={signal.imageUrl} size="lg" />
          </Link>
          <div className="min-w-0">
            <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
              <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-amber-200">
                <span className="size-1.5 animate-pulse rounded-full bg-amber-300 motion-reduce:animate-none" aria-hidden="true" />
                Just disclosed
              </span>
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
            <Link href={`/p/${signal.profileId}`} className="text-base font-semibold text-white transition-colors hover:text-emerald-200">
              {signal.headline}
            </Link>
            <p className="mt-1.5 text-sm text-zinc-400">
              <span className="font-medium text-zinc-200">{formatUsdRange(signal.amountLow, signal.amountHigh)}</span>
              {signal.xstockSymbol ? ` into ${signal.xstockSymbol}` : " · Not on allowlist"} · {formatDate(signal.filedAt)}
              {signal.transactionValue ? ` · ${formatUsd(signal.transactionValue)}` : ""}
            </p>
          </div>
        </div>
        <div className="grid shrink-0 grid-cols-2 gap-2 sm:flex">
          <CopyButton
            signalId={signal.id}
            enabled={signal.tradeEligible}
            label={sideIsBuy ? "Copy this buy" : "Copy this sell"}
          />
          <Link
            href={`/indexes/idx-${signal.profileId}`}
            className="inline-flex h-7 items-center justify-center rounded-lg border border-white/10 px-2.5 text-xs font-medium text-zinc-200 transition-colors hover:border-white/20 hover:bg-white/10"
          >
            Buy index
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}
