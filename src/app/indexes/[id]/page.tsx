import type { Metadata } from "next";
import { ConsumerIndex } from "@/components/consumer-index";
import { ThematicIndexPage } from "@/components/thematic-index";
import { TrackerIndex } from "@/components/tracker-index";
import { peopleService } from "@/lib/fmp/server";
import { isThematicIndex } from "@/lib/fomo/index-readiness";
import { publicCycleIndexEnabled } from "@/lib/index-vaults/public-cycle-release";
import { vaultIndexService } from "@/lib/index-vaults/server";
import { getThematicView } from "@/lib/thematic/views";
import { trackerPersonView } from "@/lib/tracker/views";
import { indexContentFor, shareImageForIndex } from "@/lib/frontend/index-content";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const indexId = id.startsWith("theme-") ? `idx-${id}` : id;
  const image = shareImageForIndex(indexId);
  if (!image) return {};

  const thematic = getThematicView(indexId);
  const definition = thematic ? null : await vaultIndexService.get(indexId).catch(() => null);
  const title = thematic?.indexName ?? definition?.name ?? "Public filings, mapped";
  const description = indexContentFor(indexId)?.cardHook ?? "A public-disclosure index from InsiderIndex.";
  const imageAlt = `${title} share card`;

  return {
    title,
    description,
    alternates: { canonical: `/indexes/${encodeURIComponent(id)}` },
    openGraph: { title, description, images: [{ url: image, width: 1200, height: 630, alt: imageAlt }] },
    twitter: { card: "summary_large_image", title, description, images: [{ url: image, alt: imageAlt }] },
  };
}

export default async function IndexPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  // Curated multi-member thematic research models (not person clones).
  if (isThematicIndex({ id }) || id.startsWith("theme-")) {
    const view = getThematicView(id);
    const vaultId = view?.id ?? (id.startsWith("idx-theme-") ? id : `idx-theme-${id}`);
    const savedVault = await vaultIndexService.get(vaultId).catch(() => null);
    const initialVault = savedVault ? { ...savedVault, publicFundsEnabled: publicCycleIndexEnabled(savedVault) } : null;
    return <ThematicIndexPage key={id} id={id} initialData={view ? { index: view, storage: "static-feed" } : undefined} initialVault={initialVault} />;
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
