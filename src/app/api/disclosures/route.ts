import { NextResponse } from "next/server";
import { listAllowlistedDisclosures } from "@/lib/disclosures/form4";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const ticker = searchParams.get("ticker") ?? undefined;
  const disclosures = await listAllowlistedDisclosures({
    ticker,
    code: "P",
    perPage: 25,
  });

  return NextResponse.json({
    source: process.env.FORM4API_KEY ? "form4" : "mock-form4",
    congress: "skipped",
    count: disclosures.length,
    disclosures,
  });
}
