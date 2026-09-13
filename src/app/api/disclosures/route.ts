import { NextResponse } from "next/server";
import { listAllDisclosures } from "@/lib/fomo/catalog";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const ticker = searchParams.get("ticker")?.toUpperCase();
  const disclosures = (await listAllDisclosures()).filter((row) =>
    ticker ? row.ticker === ticker : true,
  );

  const sources = [...new Set(disclosures.map((row) => row.source))].sort();
  return NextResponse.json({
    source: sources.length ? sources.join("+") : process.env.FORM4API_KEY ? "form4+congress" : "mock-form4+mock-congress",
    congress: "enabled",
    count: disclosures.length,
    form4Count: disclosures.filter((row) => row.kind === "insider").length,
    congressCount: disclosures.filter((row) => row.kind === "politician").length,
    tradeEligibleCount: disclosures.filter((row) => row.tradeEligible).length,
    disclosures,
  });
}
