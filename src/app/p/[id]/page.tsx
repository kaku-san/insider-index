import { ProfileView } from "@/components/profile-view";
import { peopleService } from "@/lib/fmp/server";
import type { PersonPortfolioResponse } from "@/lib/frontend/research-contract";

export default async function ProfilePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const initialData = /^[A-Z][0-9]{6}$/.test(id)
    ? await peopleService.portfolio(id).catch(() => undefined)
    : undefined;
  return <ProfileView key={id} id={id} initialData={initialData as PersonPortfolioResponse | undefined} />;
}
