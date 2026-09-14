/**
 * Venue resolution: where can a disclosed ticker actually be bought?
 *
 *  1. xStock on the verified Solana allowlist → in-app, user-signed Jupiter swap
 *  2. Backpack Exchange US-equity market      → external link, labelled spot/perp
 *  3. nothing we wire yet                      → visible in the book, not copyable
 */

import { getXStockByTicker } from "@/lib/allowlist";
import type { Venue, VenueListing, VenueMarket } from "@/lib/disclosures/types";
import { fetchBackpackListings } from "@/lib/venues/backpack";
import { backpackTradeUrl, type BackpackListing } from "@/lib/venues/backpack-parse";

export type VenueMap = Map<string, BackpackListing>;

export type ResolvedVenue = {
  venue: Venue;
  venueSymbol: string | null;
  venueMarket: VenueMarket | null;
  venueHref: string | null;
  xstockSymbol: string | null;
  xstockMint: string | null;
};

export const NO_VENUE: ResolvedVenue = {
  venue: "none",
  venueSymbol: null,
  venueMarket: null,
  venueHref: null,
  xstockSymbol: null,
  xstockMint: null,
};

export function resolveVenue(ticker: string, backpack: VenueMap): ResolvedVenue {
  const symbol = ticker.trim().toUpperCase();
  const xstock = getXStockByTicker(symbol);
  if (xstock) {
    return {
      venue: "xstock",
      venueSymbol: xstock.symbol,
      venueMarket: "swap",
      venueHref: null,
      xstockSymbol: xstock.symbol,
      xstockMint: xstock.mint,
    };
  }
  const listing = backpack.get(symbol);
  if (listing) {
    return {
      venue: "backpack",
      venueSymbol: listing.symbol,
      venueMarket: listing.market,
      venueHref: backpackTradeUrl(listing.symbol),
      xstockSymbol: null,
      xstockMint: null,
    };
  }
  return NO_VENUE;
}

export function listingFor(resolved: ResolvedVenue): VenueListing | null {
  if (resolved.venue === "none" || !resolved.venueSymbol || !resolved.venueMarket) return null;
  return { venue: resolved.venue, symbol: resolved.venueSymbol, market: resolved.venueMarket, href: resolved.venueHref };
}

export async function loadVenueMap(): Promise<VenueMap> {
  return fetchBackpackListings();
}

type VenueFields = ResolvedVenue & { tradeEligible: boolean };

function eligible(resolved: ResolvedVenue, side: string): boolean {
  return resolved.venue !== "none" && (side === "buy" || side === "sell");
}

/** Synchronous first pass (xStocks only). Backpack is layered on by `tagVenues`. */
export function baseVenueFields(ticker: string, side: string): VenueFields {
  const resolved = resolveVenue(ticker, new Map());
  return { ...resolved, tradeEligible: eligible(resolved, side) };
}

/** Re-tag rows once the live venue map is known. Pure over its inputs. */
export function tagVenues<T extends { ticker: string; side: string } & Partial<VenueFields>>(
  rows: readonly T[],
  backpack: VenueMap,
): (T & VenueFields)[] {
  return rows.map((row) => {
    const resolved = resolveVenue(row.ticker, backpack);
    return { ...row, ...resolved, tradeEligible: eligible(resolved, row.side) };
  });
}
