import { createHash } from "node:crypto";
import { VersionedTransaction } from "@solana/web3.js";
import { globalState } from "./cache.ts";
import { PositionStoreError, positionClient } from "./positions.ts";
import type { JupiterOrder } from "./jupiter.ts";
import type { BuyableToken } from "./allowlist.ts";

export type CopyOrder = {
  request_id: string; wallet: string; disclosure_id: string | null;
  ticker: string; token_symbol: string; venue: "xstock" | "backpack"; mint: string;
  side: "buy" | "sell"; token_decimals: number; message_hash: string;
  expires_at: string; stub: boolean;
};
const memory = () => globalState("copy_orders", () => new Map<string, CopyOrder>());

/** Signing may change signatures, never the quoted message, recipient, or amounts. */
export function transactionMessageHash(transaction: string): string {
  const decoded = VersionedTransaction.deserialize(Buffer.from(transaction, "base64"));
  return createHash("sha256").update(decoded.message.serialize()).digest("hex");
}

export async function saveCopyOrder(order: JupiterOrder, token: BuyableToken, side: "buy" | "sell", disclosureId: string | null): Promise<void> {
  if (!order.transaction || !order.taker) return; // Indicative quote: not executable.
  const row: CopyOrder = {
    request_id: order.requestId, wallet: order.taker, disclosure_id: disclosureId,
    ticker: token.ticker, token_symbol: token.symbol, venue: token.issuer, mint: token.mint,
    side, token_decimals: token.decimals,
    message_hash: order.stub ? "stub" : transactionMessageHash(order.transaction),
    expires_at: new Date(Math.min(Date.now() + 60_000, order.expireAt ? order.expireAt * 1000 : Infinity)).toISOString(), stub: order.stub,
  };
  const client = positionClient();
  if (!client) { memory().set(row.request_id, row); return; }
  const { error } = await client.from("copy_orders").insert(row);
  if (error) throw new PositionStoreError();
}

export async function loadCopyOrder(requestId: string): Promise<CopyOrder | null> {
  const client = positionClient();
  if (!client) return memory().get(requestId) ?? null;
  const { data, error } = await client.from("copy_orders").select("*").eq("request_id", requestId).maybeSingle();
  if (error) throw new PositionStoreError();
  return data as CopyOrder | null;
}

export function verifyCopyOrder(order: CopyOrder | null, wallet: string, signed: string, now = Date.now()): order is CopyOrder {
  if (!order || order.wallet !== wallet) return false;
  const expiry = Date.parse(order.expires_at);
  if (!Number.isFinite(expiry) || expiry <= now) return false;
  if (order.stub) return signed.startsWith("privy-stub:");
  try { return transactionMessageHash(signed) === order.message_hash; } catch { return false; }
}
