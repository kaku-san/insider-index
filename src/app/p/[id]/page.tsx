import { ProfileView } from "@/components/profile-view";
import { FmpPerson } from "@/components/fmp-person";
import { peopleService } from "@/lib/fmp/server";

export default async function ProfilePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  if (!/^[A-Z][0-9]{6}$/.test(id)) return <ProfileView id={id} />;
  const initialData = await peopleService.portfolio(id).catch(() => undefined);
  return <FmpPerson key={id} id={id} initialData={initialData} />;
}
