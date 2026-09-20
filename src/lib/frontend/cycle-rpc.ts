import { Connection, type ConnectionConfig } from "@solana/web3.js";

/** Wallet connection supplies signatures, not a read transport. Reuse the app's existing
 * server RPC without a browser key/extra public RPC setting. No subscriptions or sends here. */
export function createCycleReadConnection(origin: string, fetcher?: ConnectionConfig["fetch"]): Connection {
  const base = new URL(origin);
  if (!["https:", "http:"].includes(base.protocol) || base.username || base.password || base.search || base.hash || base.pathname !== "/") {
    throw new Error("CYCLE_RPC_ORIGIN_REQUIRED");
  }
  return new Connection(new URL("/api/rpc", base.origin).href, {
    commitment: "confirmed", disableRetryOnRateLimit: true, fetch: fetcher,
  });
}
