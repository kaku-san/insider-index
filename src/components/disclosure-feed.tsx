"use client";

import { useEffect, useMemo, useState } from "react";
import { DisclosureCard } from "@/components/disclosure-card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import type { Disclosure } from "@/lib/disclosures/types";

type FeedResponse = {
  source: string;
  congress: string;
  disclosures: Disclosure[];
};

export function DisclosureFeed() {
  const [query, setQuery] = useState("");
  const [source, setSource] = useState("mock-form4");
  const [disclosures, setDisclosures] = useState<Disclosure[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const response = await fetch("/api/disclosures");
        const payload = (await response.json()) as FeedResponse;
        if (!cancelled) {
          setSource(payload.source);
          setDisclosures(payload.disclosures ?? []);
        }
      } catch {
        if (!cancelled) {
          setError("Unable to load Form 4 disclosures.");
        }
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const filtered = useMemo(() => {
    const needle = query.trim().toUpperCase();
    if (!needle) return disclosures;
    return disclosures.filter((item) =>
      [item.ticker, item.issuerName, item.insiderName, item.venueSymbol ?? ""]
        .join(" ")
        .toUpperCase()
        .includes(needle),
    );
  }, [disclosures, query]);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="mb-2 flex items-center gap-2">
            <Badge variant="outline">Form4API {source}</Badge>
            <Badge variant="secondary">Congress skipped</Badge>
          </div>
          <h1 className="text-3xl font-semibold tracking-tight text-white">
            Insider disclosure feed
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-zinc-400">
            Allowlisted Form 4 buys only. Inspect a filing, choose a USDC amount,
            then sign an xStock swap on Solana. No vaults, no unattended trading.
          </p>
        </div>
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Filter ticker, insider, xStock"
          className="sm:max-w-xs"
        />
      </div>

      {error ? <p className="text-sm text-red-400">{error}</p> : null}

      <div className="grid gap-4">
        {filtered.map((disclosure) => (
          <DisclosureCard key={disclosure.id} disclosure={disclosure} />
        ))}
        {filtered.length === 0 ? (
          <p className="text-sm text-zinc-500">No disclosures match.</p>
        ) : null}
      </div>
    </div>
  );
}
