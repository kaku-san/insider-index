import { NextResponse } from "next/server";
import type { ActorKind, PoliticalParty } from "@/lib/disclosures/types";
import { listSignals } from "@/lib/fomo/catalog";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const kind = searchParams.get("kind") as ActorKind | null;
  const party = searchParams.get("party") as PoliticalParty | null;

  const signals = await listSignals({
    kind: kind ?? undefined,
    party: party ?? undefined,
  });

  return NextResponse.json({
    count: signals.length,
    signals,
  });
}
