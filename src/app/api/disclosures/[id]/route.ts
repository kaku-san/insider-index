import { NextResponse } from "next/server";
import { getDisclosure } from "@/lib/fomo/catalog";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const disclosure = await getDisclosure(id);
  if (!disclosure) {
    return NextResponse.json({ error: "Disclosure not found" }, { status: 404 });
  }
  return NextResponse.json({ disclosure });
}
