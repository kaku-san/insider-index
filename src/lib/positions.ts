import { createServiceSupabase } from "@/lib/supabase";

export type TrackedPosition = {
  id: string;
  wallet: string;
  disclosureId: string | null;
  ticker: string;
  /** Token symbol bought: `NVDAx` or `NVDA.US`. */
  tokenSymbol: string;
  venue: "xstock" | "backpack";
  mint: string;
  usdcIn: number;
  tokensOut: number;
  requestId: string;
  signature: string;
  stub: boolean;
  createdAt: string;
};

type GlobalPositions = typeof globalThis & {
  __stocklanaPositions?: TrackedPosition[];
};

function memoryStore(): TrackedPosition[] {
  const globalRef = globalThis as GlobalPositions;
  if (!globalRef.__stocklanaPositions) {
    globalRef.__stocklanaPositions = [];
  }
  return globalRef.__stocklanaPositions;
}

export async function listPositions(wallet?: string): Promise<TrackedPosition[]> {
  const supabase = createServiceSupabase();
  if (supabase) {
    let query = supabase
      .from("positions")
      .select("*")
      .order("created_at", { ascending: false });
    if (wallet) {
      query = query.eq("wallet", wallet);
    }
    const { data, error } = await query;
    if (!error && data) {
      return data as TrackedPosition[];
    }
  }

  const rows = memoryStore();
  return wallet ? rows.filter((row) => row.wallet === wallet) : [...rows];
}

export async function recordPosition(
  position: Omit<TrackedPosition, "id" | "createdAt">,
): Promise<TrackedPosition> {
  const row: TrackedPosition = {
    ...position,
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
  };

  const supabase = createServiceSupabase();
  if (supabase) {
    const { error } = await supabase.from("positions").insert({
      id: row.id,
      wallet: row.wallet,
      disclosure_id: row.disclosureId,
      ticker: row.ticker,
      token_symbol: row.tokenSymbol,
      venue: row.venue,
      mint: row.mint,
      usdc_in: row.usdcIn,
      tokens_out: row.tokensOut,
      request_id: row.requestId,
      signature: row.signature,
      stub: row.stub,
      created_at: row.createdAt,
    });
    if (!error) {
      return row;
    }
  }

  memoryStore().unshift(row);
  return row;
}
