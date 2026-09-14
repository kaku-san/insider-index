import { IndexHome, type SavedDirectory } from "@/components/index-home";
import { peopleService } from "@/lib/fmp/server";

export const dynamic = "force-dynamic";
export default async function HomePage() {
  let initialData: SavedDirectory | undefined;
  try {
    const saved = await peopleService.directory();
    initialData = { ...saved, total: saved.people.length };
  } catch {
    // The client retries the saved-data API and renders a safe error if unavailable.
  }
  return <IndexHome initialData={initialData} />;
}
