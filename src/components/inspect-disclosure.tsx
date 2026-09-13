"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { formatDate, formatShares, formatUsd, shortenAddress } from "@/lib/format";
import type { Disclosure } from "@/lib/disclosures/types";

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-3 gap-3 py-2 text-sm">
      <dt className="text-zinc-500">{label}</dt>
      <dd className="col-span-2 font-medium text-zinc-100">{value}</dd>
    </div>
  );
}

export function InspectDisclosure({ id }: { id: string }) {
  const [disclosure, setDisclosure] = useState<Disclosure | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const response = await fetch(`/api/disclosures/${id}`);
      if (!response.ok) {
        if (!cancelled) setError("Disclosure not found.");
        return;
      }
      const payload = (await response.json()) as { disclosure: Disclosure };
      if (!cancelled) setDisclosure(payload.disclosure);
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (error) {
    return <p className="text-sm text-red-400">{error}</p>;
  }

  if (!disclosure) {
    return <p className="text-sm text-zinc-500">Loading filing…</p>;
  }

  return (
    <div className="space-y-6">
      <div>
        <p className="text-xs uppercase tracking-[0.2em] text-emerald-300">Inspect</p>
        <h1 className="mt-2 text-3xl font-semibold text-white">
          {disclosure.ticker} insider buy
        </h1>
        <p className="mt-1 text-zinc-400">
          {disclosure.insiderName} filed a Form 4 for {disclosure.issuerName}.
        </p>
      </div>

      <Card className="border-white/10 bg-white/[0.03]">
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <div>
              <CardTitle className="text-white">{disclosure.issuerName}</CardTitle>
              <CardDescription>Accession {disclosure.accessionNumber}</CardDescription>
            </div>
            <Badge variant={disclosure.tradeEligible ? "default" : "secondary"}>
              {disclosure.tradeEligible ? `${disclosure.xstockSymbol} allowlisted` : "Blocked"}
            </Badge>
          </div>
        </CardHeader>
        <CardContent>
          <dl>
            <Row label="Insider" value={`${disclosure.insiderName} · CIK ${disclosure.insiderCik}`} />
            <Row label="Title" value={disclosure.insiderTitle ?? "—"} />
            <Row label="Code" value={`${disclosure.transactionCode} (${disclosure.side})`} />
            <Row label="Trade date" value={formatDate(disclosure.transactionDate)} />
            <Row label="Filed" value={formatDate(disclosure.filedAt)} />
            <Row label="Shares" value={formatShares(disclosure.sharesAmount)} />
            <Row label="Price" value={formatUsd(disclosure.pricePerShare)} />
            <Row label="Value" value={formatUsd(disclosure.transactionValue)} />
            <Row label="Owned after" value={formatShares(disclosure.sharesOwnedAfter)} />
            <Row label="10b5-1" value={disclosure.is10b51 ? "Yes" : "No"} />
          </dl>
          <Separator className="my-4 bg-white/10" />
          <dl>
            <Row label="xStock" value={disclosure.xstockSymbol ?? "Not allowlisted"} />
            <Row
              label="Mint"
              value={disclosure.xstockMint ? shortenAddress(disclosure.xstockMint, 6) : "—"}
            />
            <Row label="Source" value={disclosure.source} />
          </dl>
        </CardContent>
      </Card>

      <div className="flex gap-3">
        <Button variant="outline" render={<Link href="/" />}>
          Back to feed
        </Button>
        {disclosure.tradeEligible ? (
          <Button render={<Link href={`/trade/${disclosure.id}`} />}>
            Continue to amount
          </Button>
        ) : (
          <Button disabled>Buy not eligible</Button>
        )}
      </div>
    </div>
  );
}
