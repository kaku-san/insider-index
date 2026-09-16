import { ConsumerIndex } from "@/components/consumer-index";
import { ThematicIndexPage } from "@/components/thematic-index";
import { TrackerIndex } from "@/components/tracker-index";
import { peopleService } from "@/lib/fmp/server";
import { isThematicIndex } from "@/lib/fomo/index-readiness";
import { getThematicView } from "@/lib/thematic/views";
import { trackerPersonView } from "@/lib/tracker/views";

export default async function IndexPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  // Curated multi-member thematic research models (not person clones).
  if (isThematicIndex({ id }) || id.startsWith("theme-")) {
    const view = getThematicView(id);
    return <ThematicIndexPage key={id} id={id} initialData={view ? { index: view, storage: "static-feed" } : undefined} />;
  }
  // Vault-ready tracker-positions index built from FMP mids + xStock mints + observed Raydium pools.
  if (id.startsWith("tracker-")) {
    const personId = id.slice("tracker-".length);
    const validId = /^[A-Z][0-9]{6}$/.test(personId);
    const saved = validId ? await peopleService.portfolio(personId).catch(() => undefined) : undefined;
    const view = validId ? await trackerPersonView(personId, saved?.indexName ?? null).catch(() => null) : null;
    return <TrackerIndex key={id} personId={personId} initialData={view ?? undefined} fmpIndexHash={saved?.publishedIndex?.hash ?? null} />;
  }
  return <ConsumerIndex id={id} />;
}
