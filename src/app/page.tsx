import { Suspense } from "react";
import { DiscoverHome } from "@/components/discover-home";
import { Skeleton } from "@/components/social/shared";
import type { CopySignal, FomoProfile } from "@/lib/disclosures/types";
import { listProfiles, listSignals } from "@/lib/fomo/catalog";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  let initialSignals: CopySignal[] = [];
  let initialProfiles: FomoProfile[] = [];
  try {
    [initialSignals, initialProfiles] = await Promise.all([
      listSignals(),
      listProfiles(),
    ]);
  } catch {
    // Client hook retries /api/signals and /api/profiles.
  }

  return (
    <Suspense fallback={<Skeleton cards={5} />}>
      <DiscoverHome
        initialSignals={initialSignals}
        initialProfiles={initialProfiles}
      />
    </Suspense>
  );
}
