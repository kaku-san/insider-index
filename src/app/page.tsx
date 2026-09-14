import { Suspense } from "react";
import { IndexHome } from "@/components/index-home";
import { Skeleton } from "@/components/social/shared";
import type { Disclosure, PersonIndex } from "@/lib/disclosures/types";
import { listAllDisclosures, listIndexes } from "@/lib/fomo/catalog";

export const dynamic = "force-dynamic";

// Home is indexes first. The disclosure feed lives at /feed.
export default async function HomePage() {
  let initialIndexes: PersonIndex[] = [];
  let initialDisclosures: Disclosure[] = [];
  try {
    [initialIndexes, initialDisclosures] = await Promise.all([
      listIndexes(),
      listAllDisclosures(),
    ]);
  } catch {
    // Client hook retries /api/indexes and /api/disclosures.
  }

  return (
    <Suspense fallback={<Skeleton cards={4} />}>
      <IndexHome
        initialIndexes={initialIndexes}
        initialDisclosures={initialDisclosures}
      />
    </Suspense>
  );
}
