import { ProfileView } from "@/components/profile-view";

export default async function ProfilePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <ProfileView id={id} />;
}
