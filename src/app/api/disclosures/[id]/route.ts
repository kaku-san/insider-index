import { NextResponse } from "next/server";
import { getDisclosure } from "@/lib/fomo/catalog";
import { loadTrackerFeed } from "@/lib/tracker/feed";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  if (id.startsWith("pt-")) {
    const tracked = loadTrackerFeed().disclosures.find((row) => row.id === id);
    if (tracked) {
      return NextResponse.json({ disclosure: tracked });
    }
    return NextResponse.json({ error: "Disclosure not found" }, { status: 404 });
  }
  const disclosure = await getDisclosure(id);
  if (!disclosure) {
    return NextResponse.json({ error: "Disclosure not found" }, { status: 404 });
  }
  return NextResponse.json({ disclosure });
}
