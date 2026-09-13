import { IndexTicket } from "@/components/index-ticket";

export default async function IndexPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <IndexTicket id={id} />;
}
