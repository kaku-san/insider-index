"use client";

import { useEffect, useState } from "react";
import { EquityCurve, PortfolioDonut } from "@/components/portfolio-charts";
import { PersonAvatar } from "@/components/person-avatar";
import { usePrivySolana } from "@/components/providers/privy-provider";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { FomoProfile, PersonIndex } from "@/lib/disclosures/types";
import type { IndexAllocation, IndexPosition } from "@/lib/fomo/indexes";
import { formatDate, formatUsd } from "@/lib/format";
import { partyChip } from "@/lib/fomo/party";

type QuotePayload = {
  requestId: string;
  transaction: string;
  allocations: IndexAllocation[];
};

type IndexPayload = {
  index: PersonIndex;
  profile: FomoProfile | null;
  holding: IndexPosition | null;
};

async function fetchIndexTicket(id: string, walletAddress?: string | null): Promise<IndexPayload | null> {
  const params = walletAddress ? `?wallet=${walletAddress}` : "";
  const response = await fetch(`/api/indexes/${id}${params}`);
  if (!response.ok) return null;
  return (await response.json()) as IndexPayload;
}

export function IndexTicket({ id }: { id: string }) {
  const wallet = usePrivySolana();
  const [index, setIndex] = useState<PersonIndex | null>(null);
  const [profile, setProfile] = useState<FomoProfile | null>(null);
  const [holding, setHolding] = useState<IndexPosition | null>(null);
  const [amount, setAmount] = useState("1000");
  const [attested, setAttested] = useState(false);
  const [quote, setQuote] = useState<QuotePayload | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function reload() {
    const payload = await fetchIndexTicket(id, wallet.solanaAddress);
    if (!payload) return;
    setIndex(payload.index);
    setProfile(payload.profile);
    setHolding(payload.holding);
  }

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const payload = await fetchIndexTicket(id, wallet.solanaAddress);
      if (!payload || cancelled) return;
      setIndex(payload.index);
      setProfile(payload.profile);
      setHolding(payload.holding);
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [id, wallet.solanaAddress]);

  async function requestQuote() {
    if (!index) return;
    setBusy(true);
    setStatus(null);
    const response = await fetch("/api/indexes/quote", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ indexId: index.id, usdcAmount: Number(amount) }),
    });
    const payload = (await response.json()) as QuotePayload & { error?: string };
    setBusy(false);
    if (!response.ok) {
      setStatus(payload.error ?? "Index quote failed");
      return;
    }
    setQuote(payload);
  }

  async function signBasket(rebalance = false) {
    if (!index || !quote) return;
    if (!wallet.authenticated || !wallet.solanaAddress) {
      setStatus(
        wallet.mode === "live" ? "Connect a Privy Solana wallet first." : "Connect the stub wallet first.",
      );
      return;
    }
    if (!attested) {
      setStatus("Confirm you are outside US / UK / CA / AU before signing.");
      return;
    }
    setBusy(true);
    setStatus(rebalance ? "Signing rebalance…" : "Signing index basket…");
    try {
      const signedTransaction = await wallet.signTransaction(quote.transaction);
      const response = await fetch("/api/indexes/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          wallet: wallet.solanaAddress,
          indexId: index.id,
          signedTransaction,
          requestId: quote.requestId,
          usdcAmount: Number(amount),
          allocations: quote.allocations,
          rebalance,
        }),
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Index execute failed");
      setStatus(rebalance ? "Index rebalanced." : "Index filled.");
      setQuote(null);
      await reload();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Index execute failed");
    } finally {
      setBusy(false);
    }
  }

  if (!index) {
    return <p className="text-sm text-zinc-500">Loading index…</p>;
  }

  const holdings = index.constituents.map((row) => ({
    ticker: row.ticker,
    xstockSymbol: row.xstockSymbol,
    weightPct: row.weightPct,
    valueUsd: row.valueUsd,
  }));

  return (
    <div className="space-y-8">
      <section className="relative overflow-hidden rounded-3xl border border-white/10 bg-gradient-to-br from-emerald-400/[0.14] via-sky-400/[0.05] to-transparent p-5 sm:p-7">
        <div className="absolute -right-12 -top-16 size-64 rounded-full bg-sky-400/10 blur-3xl" aria-hidden="true" />
        <div className="relative flex flex-col gap-5 sm:flex-row sm:items-center">
          <PersonAvatar name={index.name} imageUrl={index.imageUrl} size="xl" />
          <div className="min-w-0">
            <p className="eyebrow">Person index</p>
            <h1 className="mt-1 text-3xl font-semibold tracking-[-0.04em] text-white sm:text-4xl">{index.name}</h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-zinc-300">
              A live basket built from their public book. New filings update the target weights;
              you decide whether to sign each rebalance.
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              {index.party ? (
                <span className={`rounded-full px-2.5 py-1 text-xs font-medium ring-1 ${partyChip(index.party)}`}>
                  {index.party}
                </span>
              ) : null}
              <span className="rounded-full border border-white/10 bg-black/20 px-2.5 py-1 text-xs text-zinc-300">
                {index.constituents.length} allowlisted xStocks
              </span>
              <span className="rounded-full border border-white/10 bg-black/20 px-2.5 py-1 text-xs text-zinc-300">
                {index.lastDisclosureAt ? `Last filed ${formatDate(index.lastDisclosureAt)}` : "Awaiting first disclosure"}
              </span>
            </div>
          </div>
        </div>
      </section>

      {holding?.needsRebalance ? (
        <div className="flex items-start gap-3 rounded-2xl border border-amber-400/40 bg-amber-400/10 p-4 text-sm text-amber-50">
          <span className="mt-1 size-2 shrink-0 animate-pulse rounded-full bg-amber-300 motion-reduce:animate-none" aria-hidden="true" />
          <div>
            <p className="font-semibold">Fresh disclosure: basket is ready to rebalance</p>
            <p className="mt-1 text-amber-100/75">Target weights changed. Review the quote, then sign if you want to update {index.name}.</p>
          </div>
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="surface">
          <CardHeader className="pt-0">
            <p className="eyebrow">Fund holdings</p>
            <CardTitle className="mt-1 text-xl text-white">Current weights</CardTitle>
          </CardHeader>
          <CardContent>
            <PortfolioDonut holdings={holdings} title="Index" />
          </CardContent>
        </Card>
        {profile ? (
          <Card className="surface">
            <CardHeader className="pt-0">
              <p className="eyebrow">Paper performance</p>
              <CardTitle className="mt-1 text-xl text-white">Index path</CardTitle>
            </CardHeader>
            <CardContent>
              <EquityCurve points={profile.curve} label="90d index path" />
            </CardContent>
          </Card>
        ) : null}
      </div>

      <Card className="surface border-emerald-300/20 bg-gradient-to-br from-emerald-400/[0.07] to-transparent">
        <CardHeader className="pt-0">
          <p className="eyebrow">Your signed order</p>
          <CardTitle className="mt-1 text-xl text-white">
            {holding ? "Add or rebalance" : `Buy ${index.name}`}
          </CardTitle>
          <CardDescription>
            USDC is split across {index.constituents.length} allowlisted mints. Nothing executes until you sign.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="index-amount">USDC notional</Label>
            <Input
              id="index-amount"
              type="number"
              min="50"
              value={amount}
              onChange={(event) => {
                setAmount(event.target.value);
                setQuote(null);
              }}
            />
          </div>
          <label className="flex items-start gap-2 text-sm text-zinc-300">
            <input
              type="checkbox"
              className="mt-1 accent-emerald-300"
              checked={attested}
              onChange={(event) => setAttested(event.target.checked)}
            />
            I am not located in the US, UK, Canada, or Australia. This index is user-signed.
          </label>
          {quote ? (
            <div className="space-y-2 rounded-xl border border-emerald-400/20 bg-emerald-400/5 p-3 text-sm text-emerald-100">
              <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-emerald-200/70">Basket preview</p>
              {quote.allocations.map((row) => (
                <p key={row.mint}>
                  {row.xstockSymbol} {(row.weightPct * 100).toFixed(0)}% · {formatUsd(row.usdc)} → {row.tokens} tokens
                </p>
              ))}
            </div>
          ) : null}
          {status ? <p className="text-sm text-amber-200">{status}</p> : null}
          <div className="grid gap-2 sm:flex sm:flex-wrap">
            <Button className="sm:order-2" disabled={busy || !quote} onClick={() => void signBasket(false)}>
              Sign & buy index
            </Button>
            <Button className="sm:order-1" variant="outline" disabled={busy} onClick={() => void requestQuote()}>
              {quote ? "Refresh quote" : "Preview basket"}
            </Button>
            {holding ? (
              <Button
                className="sm:order-3"
                variant="secondary"
                disabled={busy || !quote}
                onClick={() => void signBasket(true)}
              >
                Sign rebalance
              </Button>
            ) : null}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
