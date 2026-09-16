import { ConsumerHome, type VaultIndexDirectory } from "@/components/consumer-home";
import { peopleService } from "@/lib/fmp/server";
import type { PeopleDirectoryResponse } from "@/lib/frontend/research-contract";
import { thematicDirectory } from "@/lib/thematic/views";
import { vaultIndexService } from "@/lib/index-vaults/server";
import { VAULT_RELEASE } from "@/lib/index-vaults/release";

export const dynamic = "force-dynamic";
export default async function HomePage() {
  let initialData: PeopleDirectoryResponse | undefined;
  let initialIndexes: VaultIndexDirectory | undefined;
  try {
    const [saved, indexes] = await Promise.all([peopleService.directory(), vaultIndexService.list()]);
    initialData = { ...saved, total: saved.people.length };
    initialIndexes = {
      count: indexes.length,
      indexes,
      publicFundsEnabled: VAULT_RELEASE.publicFundsEnabled,
      storage: "supabase",
    };
  } catch {
    // The client retries both saved-data APIs and renders a safe error if either is unavailable.
  }
  return <ConsumerHome initialData={initialData} initialThemes={thematicDirectory()} initialIndexes={initialIndexes} />;
}
