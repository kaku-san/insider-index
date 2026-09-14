import { Suspense } from "react";
import type { Metadata } from "next";
import { FeedView } from "@/components/feed-view";
import { Skeleton } from "@/components/social/shared";
import type { Disclosure } from "@/lib/disclosures/types";
import { listAllDisclosures } from "@/lib/fomo/catalog";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Feed",
  description: "Every public Form 4 and Congress disclosure on the tape, newest first.",
};

export default async function FeedPage() {
  let initialDisclosures: Disclosure[] = [];
  try {
    initialDisclosures = await listAllDisclosures();
  } catch {
    // Client hook retries /api/disclosures.
  }

  return (
    <Suspense fallback={<Skeleton cards={5} />}>
      <FeedView initialDisclosures={initialDisclosures} />
    </Suspense>
  );
}
