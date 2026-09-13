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
import { formatUsd } from "@/lib/format";

type QuotePayload = {
  requestId: string;
  transaction: string;
  allocations: IndexAllocation[];
};

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
    const params = wallet.solanaAddress ? `?wallet=${wallet.solanaAddress}` : "";
    const response = await fetch(`/api/indexes/${id}${params}`);
    if (!response.ok) return;
    const payload = (await response.json()) as {
      index: PersonIndex;
      profile: FomoProfile | null;
      holding: IndexPosition | null;
    };
    setIndex(payload.index);
    setProfile(payload.profile);
    setHolding(payload.holding);
  }

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      setStatus("Connect the stub wallet first.");
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
    <div className="space-y-6">
      <div className="flex items-start gap-4">
        <PersonAvatar name={index.name} imageUrl={index.imageUrl} size="lg" />
        <div>
          <p className="text-xs uppercase tracking-[0.2em] text-emerald-300">Person index</p>
          <h1 className="mt-2 text-3xl font-semibold text-white">{index.name}</h1>
          <p className="mt-1 text-zinc-400">
            Basket of allowlisted xStocks from their disclosed book. A new Form 4 or PTR
            marks the index for a user-signed rebalance — not an unattended vault.
          </p>
        </div>
      </div>

      {holding?.needsRebalance ? (
        <div className="rounded-xl border border-amber-400/40 bg-amber-400/10 p-4 text-sm text-amber-50">
          New disclosure landed. Target weights moved. Sign to rebalance {index.name}.
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="border-white/10 bg-white/[0.03]">
          <CardHeader>
            <CardTitle className="text-white">Current book</CardTitle>
          </CardHeader>
          <CardContent>
            <PortfolioDonut holdings={holdings} title="Index" />
          </CardContent>
        </Card>
        {profile ? (
          <Card className="border-white/10 bg-white/[0.03]">
            <CardHeader>
              <CardTitle className="text-white">Copy path</CardTitle>
            </CardHeader>
            <CardContent>
              <EquityCurve points={profile.curve} />
            </CardContent>
          </Card>
        ) : null}
      </div>

      <Card className="border-white/10 bg-white/[0.03]">
        <CardHeader>
          <CardTitle className="text-white">
            {holding ? "Add or rebalance" : `Buy ${index.name}`}
          </CardTitle>
          <CardDescription>
            USDC is split across {index.constituents.length} mints. You sign the basket once.
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
              className="mt-1"
              checked={attested}
              onChange={(event) => setAttested(event.target.checked)}
            />
            I am not located in the US, UK, Canada, or Australia. This index is user-signed.
          </label>
          {quote ? (
            <div className="space-y-1 rounded-lg border border-emerald-400/20 bg-emerald-400/5 p-3 text-sm text-emerald-100">
              {quote.allocations.map((row) => (
                <p key={row.mint}>
                  {row.xstockSymbol} {(row.weightPct * 100).toFixed(0)}% · {formatUsd(row.usdc)} → {row.tokens} tokens
                </p>
              ))}
            </div>
          ) : null}
          {status ? <p className="text-sm text-amber-200">{status}</p> : null}
          <div className="flex flex-wrap gap-3">
            <Button variant="outline" disabled={busy} onClick={() => void requestQuote()}>
              Quote basket
            </Button>
            <Button disabled={busy || !quote} onClick={() => void signBasket(false)}>
              Sign & buy index
            </Button>
            {holding ? (
              <Button
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
