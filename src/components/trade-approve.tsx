"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { usePrivySolana } from "@/components/providers/privy-provider";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatShares, formatUsd } from "@/lib/format";
import type { Disclosure } from "@/lib/disclosures/types";
import type { JupiterOrder } from "@/lib/jupiter";
import { fromAtomicAmount, getXStockByMint } from "@/lib/allowlist";

type QuoteResponse = { order: JupiterOrder; error?: string };

export function TradeApprove({ id }: { id: string }) {
  const router = useRouter();
  const wallet = usePrivySolana();
  const [disclosure, setDisclosure] = useState<Disclosure | null>(null);
  const [amount, setAmount] = useState("250");
  const [attested, setAttested] = useState(false);
  const [order, setOrder] = useState<JupiterOrder | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const response = await fetch(`/api/disclosures/${id}`);
      if (!response.ok) return;
      const payload = (await response.json()) as { disclosure: Disclosure };
      if (!cancelled) setDisclosure(payload.disclosure);
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [id]);

  async function requestQuote() {
    if (!disclosure?.xstockMint) return;
    setBusy(true);
    setStatus(null);
    try {
      const response = await fetch("/api/quote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          outputMint: disclosure.xstockMint,
          usdcAmount: Number(amount),
          taker: wallet.solanaAddress ?? undefined,
          side: disclosure.side === "sell" ? "sell" : "buy",
        }),
      });
      const payload = (await response.json()) as QuoteResponse & { error?: string };
      if (!response.ok) {
        throw new Error(payload.error ?? "Quote failed");
      }
      setOrder(payload.order);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Quote failed");
    } finally {
      setBusy(false);
    }
  }

  async function approveAndExecute() {
    if (!disclosure?.xstockMint || !order) return;
    if (!wallet.authenticated || !wallet.solanaAddress) {
      setStatus("Connect the Privy Solana stub wallet first.");
      return;
    }
    if (!attested) {
      setStatus("Confirm you are outside US / UK / CA / AU before signing.");
      return;
    }

    setBusy(true);
    setStatus("Waiting for user signature…");
    try {
      const signedTransaction = await wallet.signTransaction(order.transaction);
      setStatus("Submitting Jupiter /execute stub…");
      const response = await fetch("/api/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          signedTransaction,
          requestId: order.requestId,
          wallet: wallet.solanaAddress,
          disclosureId: disclosure.id,
          ticker: disclosure.ticker,
          outputMint: disclosure.xstockMint,
          inAmount: order.inAmount,
          outAmount: order.outAmount,
        }),
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(payload.error ?? "Execute failed");
      }
      router.push("/positions");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Execute failed");
    } finally {
      setBusy(false);
    }
  }

  if (!disclosure) {
    return <p className="text-sm text-zinc-500">Loading trade ticket…</p>;
  }

  const xstock = disclosure.xstockMint ? getXStockByMint(disclosure.xstockMint) : undefined;
  const estimatedOut =
    order && xstock ? fromAtomicAmount(order.outAmount, xstock.decimals) : null;

  return (
    <div className="space-y-6">
      <div>
        <p className="text-xs uppercase tracking-[0.2em] text-emerald-300">
          Copy {disclosure.kind === "politician" ? "Congress" : "insider"} print
        </p>
        <h1 className="mt-2 text-3xl font-semibold text-white">
          {disclosure.side === "sell" ? "Copy sell" : "Copy buy"} {disclosure.xstockSymbol} from {disclosure.insiderName}
        </h1>
        <p className="mt-1 text-zinc-400">
          USDC in, allowlisted xStock out. Jupiter Swap V2 is stubbed as /order →
          user sign → /execute.
        </p>
      </div>

      <Card className="border-white/10 bg-white/[0.03]">
        <CardHeader>
          <CardTitle className="text-white">Trade ticket</CardTitle>
          <CardDescription>
            {disclosure.insiderName} bought {formatShares(disclosure.sharesAmount)} {disclosure.ticker}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="usdc-amount">USDC amount</Label>
            <Input
              id="usdc-amount"
              type="number"
              min="1"
              step="1"
              value={amount}
              onChange={(event) => {
                setAmount(event.target.value);
                setOrder(null);
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
            I am not located in the United States, United Kingdom, Canada, or Australia,
            and I understand this is a user-signed stub, not unattended trading.
          </label>
          {order ? (
            <div className="rounded-lg border border-emerald-400/20 bg-emerald-400/5 p-3 text-sm text-emerald-100">
              <p>Quote {order.mode}: {formatUsd(Number(amount))} USDC</p>
              <p>
                Est. receive {estimatedOut != null ? formatShares(estimatedOut) : "—"}{" "}
                {disclosure.xstockSymbol}
              </p>
              <p className="font-mono text-xs text-emerald-200/80">
                requestId {order.requestId}
              </p>
            </div>
          ) : null}
          {status ? <p className="text-sm text-amber-200">{status}</p> : null}
          <div className="flex flex-wrap gap-3">
            <Button variant="outline" onClick={() => void requestQuote()} disabled={busy}>
              Get Jupiter order
            </Button>
            <Button onClick={() => void approveAndExecute()} disabled={busy || !order}>
              Approve & sign
            </Button>
            <Button
              nativeButton={false}
              variant="ghost"
              render={<Link href={`/disclosures/${disclosure.id}`} />}
            >
              Back to inspect
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
