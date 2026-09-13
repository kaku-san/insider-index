import { NextResponse } from "next/server";
import { listFollows, unfollow, upsertFollow } from "@/lib/fomo/follows";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const wallet = searchParams.get("wallet") ?? undefined;
  const follows = listFollows(wallet);
  return NextResponse.json({ count: follows.length, follows });
}

export async function POST(request: Request) {
  const body = (await request.json()) as {
    wallet?: string;
    profileId?: string;
    autoCopy?: boolean;
    unfollow?: boolean;
  };

  if (!body.wallet || !body.profileId) {
    return NextResponse.json(
      { error: "wallet and profileId are required." },
      { status: 400 },
    );
  }

  if (body.unfollow) {
    unfollow(body.wallet, body.profileId);
    return NextResponse.json({ ok: true, follows: listFollows(body.wallet) });
  }

  const follow = upsertFollow({
    wallet: body.wallet,
    profileId: body.profileId,
    autoCopy: Boolean(body.autoCopy),
  });

  return NextResponse.json({ follow, follows: listFollows(body.wallet) });
}
