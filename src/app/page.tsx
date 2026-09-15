import { ConsumerHome } from "@/components/consumer-home";
import { peopleService } from "@/lib/fmp/server";
import type { PeopleDirectoryResponse } from "@/lib/frontend/research-contract";

export const dynamic = "force-dynamic";
export default async function HomePage() {
  let initialData: PeopleDirectoryResponse | undefined;
  try {
    const saved = await peopleService.directory();
    initialData = { ...saved, total: saved.people.length };
  } catch {
    // The client retries the saved-data API and renders a safe error if unavailable.
  }
  return <ConsumerHome initialData={initialData} />;
}
