import { FmpPerson } from "@/components/fmp-person";
import { ProfileView } from "@/components/profile-view";
import { peopleService } from "@/lib/fmp/server";
import { trackerPersonView } from "@/lib/tracker/views";

export default async function ProfilePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  if (!/^[A-Z][0-9]{6}$/.test(id)) return <ProfileView key={id} id={id} />;
  const initialData = await peopleService.portfolio(id).catch(() => undefined);
  // PelosiTracker handoff people render from the committed dataset even when no FMP book is saved.
  const tracker = await trackerPersonView(id, initialData?.indexName ?? null).catch(() => null);
  return <FmpPerson key={id} id={id} initialData={initialData} tracker={tracker} />;
}
