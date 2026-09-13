import { TradeApprove } from "@/components/trade-approve";

export default async function TradePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <TradeApprove id={id} />;
}
