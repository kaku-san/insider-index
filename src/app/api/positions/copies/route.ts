import { PublicKey } from "@solana/web3.js";
import { listPositions } from "../../../../lib/positions.ts";
import { isStubWallet } from "../../../../lib/wallet.ts";

export const runtime = "nodejs";
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const wallet = params.get("wallet");
  try {
    if (!wallet || params.getAll("wallet").length !== 1 || isStubWallet(wallet)) throw new Error();
    new PublicKey(wallet);
  } catch { return Response.json({ error: "A valid Solana wallet is required." }, { status: 400 }); }
  try {
    const positions = await listPositions(wallet);
    return Response.json({ positions, kind: "copy-receipts", valuation: null }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "Copy receipts unavailable. No balance is inferred." }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
