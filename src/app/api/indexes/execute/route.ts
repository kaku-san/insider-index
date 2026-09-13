import { NextResponse } from "next/server";
import { getIndex } from "@/lib/fomo/catalog";
import {
  applyRebalance,
  listIndexPositions,
  recordIndexPosition,
  type IndexAllocation,
} from "@/lib/fomo/indexes";

export async function POST(request: Request) {
  const body = (await request.json()) as {
    wallet?: string;
    indexId?: string;
    signedTransaction?: string;
    requestId?: string;
    usdcAmount?: number;
    allocations?: IndexAllocation[];
    rebalance?: boolean;
  };

  if (!body.wallet || !body.indexId || !body.signedTransaction || !body.requestId) {
    return NextResponse.json(
      { error: "wallet, indexId, signedTransaction, and requestId are required." },
      { status: 400 },
    );
  }

  const index = await getIndex(body.indexId);
  if (!index) {
    return NextResponse.json({ error: "Index not found" }, { status: 404 });
  }

  const signature = `STUBIDX${body.requestId.replace(/[^A-Za-z0-9]/g, "").slice(0, 60)}`;
  const allocations = body.allocations ?? [];

  if (body.rebalance) {
    const existing = listIndexPositions(body.wallet).find((row) => row.indexId === index.id);
    const updated = applyRebalance(body.wallet, index.id, {
      allocations,
      lastDisclosureId: index.lastDisclosureId,
      signature,
      usdcIn: body.usdcAmount ?? existing?.usdcIn ?? 0,
    });
    if (!updated) {
      return NextResponse.json({ error: "No index holding to rebalance." }, { status: 404 });
    }
    return NextResponse.json({ flow: "person-index-rebalance", holding: updated, index });
  }

  const holding = recordIndexPosition({
    wallet: body.wallet,
    indexId: index.id,
    indexName: index.name,
    usdcIn: Number(body.usdcAmount ?? 0),
    allocations,
    lastDisclosureId: index.lastDisclosureId,
    signature,
  });

  return NextResponse.json({ flow: "person-index-execute", holding, index });
}
