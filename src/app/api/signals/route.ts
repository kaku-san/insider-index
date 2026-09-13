import { NextResponse } from "next/server";
import type { ActorKind, PoliticalParty } from "@/lib/disclosures/types";
import { listSignals } from "@/lib/fomo/catalog";
import { listFollows } from "@/lib/fomo/follows";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const kind = searchParams.get("kind") as ActorKind | null;
  const party = searchParams.get("party") as PoliticalParty | null;
  const following = searchParams.get("following") === "1";
  const wallet = searchParams.get("wallet") ?? undefined;

  const followed = new Set(listFollows(wallet).map((row) => row.profileId));
  const signals = (await listSignals({
    kind: kind ?? undefined,
    party: party ?? undefined,
  })).filter((signal) => (following ? followed.has(signal.profileId) : true));

  return NextResponse.json({
    count: signals.length,
    signals,
  });
}
