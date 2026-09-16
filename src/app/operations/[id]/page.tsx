import { OperationStatus } from "@/components/operation-status";

export default async function OperationPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <OperationStatus operationId={decodeURIComponent(id)} />;
}
