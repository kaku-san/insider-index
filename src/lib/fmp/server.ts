import "server-only";
import { createServiceSupabase } from "@/lib/supabase";
import { PeopleError } from "./service";
import { createStoredPeopleService } from "./store";

// Public reads never fetch FMP or touch its private filesystem archive.
function store() {
  const db = createServiceSupabase();
  if (!db) throw new PeopleError(503, "saved-data-unconfigured");
  return createStoredPeopleService(db);
}
export const peopleService = {
  directory: () => store().directory(),
  portfolio: (id: string) => store().portfolio(id),
  publishedIndex: (hash: string) => store().publishedIndex(hash),
};
