import { NextResponse } from "next/server";
import { listDisclosureTape } from "@/lib/fomo/catalog";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const ticker = searchParams.get("ticker")?.toUpperCase();
  const tape = await listDisclosureTape();
  const disclosures = tape.disclosures.filter((row) =>
    ticker ? row.ticker === ticker : true,
  );

  const sources = [...new Set(disclosures.map((row) => row.source))].sort();
  return NextResponse.json(
    {
      source: sources.length
        ? sources.join("+")
        : `${tape.lanes.insiders.source}+${tape.lanes.congress.source}`,
      lanes: tape.lanes,
      live: tape.lanes.insiders.live || tape.lanes.congress.live,
      congress: tape.lanes.congress.source === "off" ? "off" : "enabled",
      count: disclosures.length,
      form4Count: disclosures.filter((row) => row.kind === "insider").length,
      congressCount: disclosures.filter((row) => row.kind === "politician").length,
      tradeEligibleCount: disclosures.filter((row) => row.tradeEligible).length,
      disclosures,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
