/**
 * Venue resolution: which Solana mint do we swap into for a disclosed ticker?
 *
 *  1. xStock mint (Backed)          → venue "xstock",   e.g. NVDAx
 *  2. Backpack tokenised stock mint → venue "backpack", e.g. NVDA.US
 *  3. neither                       → venue "none": visible in the book, not copyable
 *
 * Both routable venues execute the same way — a user-signed Jupiter swap from
 * USDC into the mint. A thin Backpack pool fails at quote time; the holding
 * still shows.
 */

import type { Venue, VenueFields } from "@/lib/disclosures/types";
import { preferredToken, type CatalogIndex } from "@/lib/venues/catalog-parse";
import { loadSolanaCatalog, snapshotCatalog } from "@/lib/venues/solana-catalog";

export const NO_VENUE: VenueFields = { venue: "none", venueSymbol: null, mint: null, mintDecimals: null };

export function resolveVenue(ticker: string, catalog: CatalogIndex): VenueFields {
  const token = preferredToken(catalog, ticker);
  if (!token) return NO_VENUE;
  return { venue: token.issuer, venueSymbol: token.symbol, mint: token.mint, mintDecimals: token.decimals };
}

export function routable(venue: Venue): venue is Exclude<Venue, "none"> {
  return venue !== "none";
}

type Tagged = VenueFields & { tradeEligible: boolean };

function eligible(fields: VenueFields, side: string): boolean {
  return routable(fields.venue) && Boolean(fields.mint) && (side === "buy" || side === "sell");
}

/** Synchronous first pass from the committed snapshot; `tagVenues` re-tags once the live catalog lands. */
export function baseVenueFields(ticker: string, side: string): Tagged {
  const fields = resolveVenue(ticker, snapshotCatalog());
  return { ...fields, tradeEligible: eligible(fields, side) };
}

/** Re-tag rows against a catalog. Pure over its inputs. */
export function tagVenues<T extends { ticker: string; side: string }>(rows: readonly T[], catalog: CatalogIndex): (T & Tagged)[] {
  return rows.map((row) => {
    const fields = resolveVenue(row.ticker, catalog);
    return { ...row, ...fields, tradeEligible: eligible(fields, row.side) };
  });
}

export async function loadVenueCatalog(): Promise<CatalogIndex> {
  return loadSolanaCatalog();
}
