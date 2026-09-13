import { InspectDisclosure } from "@/components/inspect-disclosure";

export default async function DisclosurePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <InspectDisclosure id={id} />;
}
