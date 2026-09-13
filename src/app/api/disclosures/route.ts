import { NextResponse } from "next/server";
import { listAllDisclosures } from "@/lib/fomo/catalog";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const ticker = searchParams.get("ticker")?.toUpperCase();
  const disclosures = (await listAllDisclosures()).filter((row) =>
    ticker ? row.ticker === ticker : true,
  );

  return NextResponse.json({
    source: process.env.FORM4API_KEY ? "form4+congress" : "mock-form4+mock-congress",
    congress: "enabled",
    count: disclosures.length,
    disclosures,
  });
}
