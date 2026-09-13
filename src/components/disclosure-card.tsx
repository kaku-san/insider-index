import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { formatDate, formatShares, formatUsd } from "@/lib/format";
import type { Disclosure } from "@/lib/disclosures/types";

export function DisclosureCard({ disclosure }: { disclosure: Disclosure }) {
  return (
    <Card className="border-white/10 bg-white/[0.03]">
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="text-lg text-white">
              {disclosure.ticker} · {disclosure.issuerName}
            </CardTitle>
            <CardDescription className="text-zinc-400">
              {disclosure.insiderName}
              {disclosure.insiderTitle ? ` · ${disclosure.insiderTitle}` : ""}
            </CardDescription>
          </div>
          <Badge variant={disclosure.tradeEligible ? "default" : "secondary"}>
            {disclosure.tradeEligible ? "Buy eligible" : "Not tradable"}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="grid grid-cols-2 gap-3 text-sm text-zinc-300 sm:grid-cols-4">
        <div>
          <p className="text-xs uppercase tracking-wide text-zinc-500">Shares</p>
          <p className="font-medium text-white">{formatShares(disclosure.sharesAmount)}</p>
        </div>
        <div>
          <p className="text-xs uppercase tracking-wide text-zinc-500">Price</p>
          <p className="font-medium text-white">{formatUsd(disclosure.pricePerShare)}</p>
        </div>
        <div>
          <p className="text-xs uppercase tracking-wide text-zinc-500">Value</p>
          <p className="font-medium text-white">{formatUsd(disclosure.transactionValue)}</p>
        </div>
        <div>
          <p className="text-xs uppercase tracking-wide text-zinc-500">xStock</p>
          <p className="font-medium text-emerald-300">{disclosure.xstockSymbol ?? "—"}</p>
        </div>
      </CardContent>
      <CardFooter className="flex items-center justify-between border-t border-white/10">
        <p className="text-xs text-zinc-500">Filed {formatDate(disclosure.filedAt)}</p>
        <Button render={<Link href={`/disclosures/${disclosure.id}`} />}>
          Inspect
          <ArrowUpRight />
        </Button>
      </CardFooter>
    </Card>
  );
}
