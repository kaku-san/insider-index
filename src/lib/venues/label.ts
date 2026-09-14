// Pure venue labels. Safe to import from client components.
import type { Venue, VenueMarket } from "@/lib/disclosures/types";

export type VenueTag = { venue: Venue; venueSymbol: string | null; venueMarket: VenueMarket | null };

/** "NVDAx · xStock", "Backpack perp", "Not tradable yet". */
export function venueLabel(row: VenueTag): string {
  if (row.venue === "xstock") return `${row.venueSymbol ?? "xStock"} · xStock`;
  if (row.venue === "backpack") return `Backpack ${row.venueMarket === "perp" ? "perp" : "spot"}`;
  return "Not tradable yet";
}

/** Short copy-action label per venue. */
export function venueActionLabel(venue: Venue): string {
  if (venue === "xstock") return "Copy trade";
  if (venue === "backpack") return "Trade on Backpack";
  return "Not tradable yet";
}
