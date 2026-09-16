import { PositionDetail } from "@/components/position-detail";

export default async function PositionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <PositionDetail indexId={decodeURIComponent(id)} />;
}
