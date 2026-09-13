"use client";

import { useEffect, useState } from "react";
import { usePrivySolana } from "@/components/providers/privy-provider";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatDate, formatShares, formatUsd, shortenAddress } from "@/lib/format";
import type { TrackedPosition } from "@/lib/positions";

export function PositionsTable() {
  const wallet = usePrivySolana();
  const [positions, setPositions] = useState<TrackedPosition[]>([]);
  const [persistence, setPersistence] = useState("memory");

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const params = new URLSearchParams();
      if (wallet.solanaAddress) {
        params.set("wallet", wallet.solanaAddress);
      }
      const response = await fetch(`/api/positions?${params.toString()}`);
      const payload = (await response.json()) as {
        persistence: string;
        positions: TrackedPosition[];
      };
      if (!cancelled) {
        setPersistence(payload.persistence);
        setPositions(payload.positions ?? []);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [wallet.solanaAddress]);

  return (
    <div className="space-y-6">
      <div>
        <div className="mb-2">
          <Badge variant="outline">Persistence {persistence}</Badge>
        </div>
        <h1 className="text-3xl font-semibold text-white">Tracked positions</h1>
        <p className="mt-1 text-sm text-zinc-400">
          User-signed xStock buys only. Connect the stub wallet to filter to your
          session, or leave it disconnected to see the in-memory book.
        </p>
      </div>

      <div className="overflow-hidden rounded-xl border border-white/10">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>xStock</TableHead>
              <TableHead>USDC in</TableHead>
              <TableHead>Tokens</TableHead>
              <TableHead>Wallet</TableHead>
              <TableHead>Signature</TableHead>
              <TableHead>When</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {positions.map((position) => (
              <TableRow key={position.id}>
                <TableCell className="font-medium text-white">
                  {position.xstockSymbol}
                  <div className="text-xs text-zinc-500">{position.ticker}</div>
                </TableCell>
                <TableCell>{formatUsd(position.usdcIn)}</TableCell>
                <TableCell>{formatShares(position.tokensOut)}</TableCell>
                <TableCell className="font-mono text-xs">
                  {shortenAddress(position.wallet)}
                </TableCell>
                <TableCell className="font-mono text-xs">
                  {shortenAddress(position.signature, 6)}
                  {position.stub ? (
                    <span className="ml-2 text-amber-300">stub</span>
                  ) : null}
                </TableCell>
                <TableCell>{formatDate(position.createdAt)}</TableCell>
              </TableRow>
            ))}
            {positions.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="py-8 text-center text-zinc-500">
                  No positions yet. Inspect a Form 4 and complete a signed stub trade.
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
