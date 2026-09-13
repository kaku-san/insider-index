import { NextResponse } from "next/server";
import { getDisclosureById } from "@/lib/disclosures/form4";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const disclosure = await getDisclosureById(id);
  if (!disclosure) {
    return NextResponse.json({ error: "Disclosure not found" }, { status: 404 });
  }
  return NextResponse.json({ disclosure });
}
