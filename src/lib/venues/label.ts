// Pure venue labels. Safe to import from client components.
import type { Venue } from "@/lib/disclosures/types";

export type VenueTag = { venue: Venue; venueSymbol: string | null };

/** "NVDAx · xStock", "NVDA.US · Backpack", "No Solana mint yet". */
export function venueLabel(row: VenueTag): string {
  if (row.venue === "xstock") return `${row.venueSymbol ?? "xStock"} · xStock`;
  if (row.venue === "backpack") return `${row.venueSymbol ?? "Backpack"} · Backpack`;
  return "No Solana mint yet";
}

export function venueIssuerName(venue: Venue): string {
  if (venue === "xstock") return "xStocks";
  if (venue === "backpack") return "Backpack";
  return "not on Solana";
}
