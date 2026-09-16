import "server-only";
import { createServiceSupabase } from "@/lib/supabase";
import { PeopleError } from "./service";
import { createStoredPeopleService } from "./store";

// Public reads never fetch FMP or persist raw captures.
function store() {
  const db = createServiceSupabase();
  if (!db) throw new PeopleError(503, "saved-data-unconfigured");
  return createStoredPeopleService(db);
}
// Each method is async so a synchronous throw from store() (e.g. Supabase unconfigured) becomes
// a rejected promise instead of propagating past any .then()/.catch() chained by the caller.
export const peopleService = {
  directory: async () => store().directory(),
  portfolio: async (id: string) => store().portfolio(id),
  publishedIndex: async (hash: string) => store().publishedIndex(hash),
  topProfiles: async () => store().topProfiles(),
};
