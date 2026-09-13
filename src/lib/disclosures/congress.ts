/**
 * Congress trading adapter — skipped for Stocklana V1.
 *
 * Form4API is the primary disclosure source. Congressional trades are
 * optional later and must not be wired into the feed, inspect, or trade
 * paths in this release.
 */

export const CONGRESS_ADAPTER_ENABLED = false;

export type CongressTrade = never;

export async function fetchCongressTrades(): Promise<CongressTrade[]> {
  return [];
}
