import { NextResponse } from "next/server";
import type { ActorKind, PoliticalParty } from "@/lib/disclosures/types";
import { listProfiles } from "@/lib/fomo/catalog";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const kind = searchParams.get("kind") as ActorKind | null;
  const party = searchParams.get("party") as PoliticalParty | null;

  const profiles = (await listProfiles()).filter((profile) => {
    if (kind && profile.kind !== kind) return false;
    if (party && profile.party !== party) return false;
    return true;
  });

  return NextResponse.json({ count: profiles.length, profiles });
}
