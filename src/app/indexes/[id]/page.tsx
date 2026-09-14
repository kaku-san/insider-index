import { IndexTicket } from "@/components/index-ticket";
import { FmpIndex } from "@/components/fmp-person";
import { peopleService } from "@/lib/fmp/server";

export default async function IndexPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  if (!id.startsWith("fmp-")) return <IndexTicket id={id} />;
  const hash = id.slice(4);
  const index = await peopleService.publishedIndex(hash).catch(() => null);
  return <FmpIndex key={id} hash={hash} initialData={index ? { index } : undefined} />;
}
