/**
 * A wallet's pro-rata slice of what a NAV vault actually holds on chain: user shares / share supply
 * × each leg's free token balance and the free USDC buffer (reserved withdrawal slices excluded,
 * matching the program's NAV and in-kind math). Valued at the keeper-posted marks. Never the target mix.
 * Pure and dependency-free so both the API and the position page can use it.
 */

export type NavHeldLeg = { ticker: string; mint: string; decimals: number; amountRaw: string; valueUsdc: string; weightBps: number };
export type NavHeldBook = {
  legs: NavHeldLeg[];
  usdc: { amountRaw: string; valueUsdc: string; weightBps: number };
  totalUsdc: string;
  markedAt: string | null;
  pricesFresh: boolean;
};

export type NavHeldInput = {
  shares: bigint;
  supply: bigint;
  usdcBalance: bigint;
  reservedUsdc: bigint;
  /** price is micro-USDC per whole token, as posted on chain. */
  legs: { ticker: string; mint: string; decimals: number; price: bigint; reserved: bigint; balance: bigint }[];
  markedAt?: string | null;
  pricesFresh?: boolean;
};

const free = (balance: bigint, reserved: bigint) => balance > reserved ? balance - reserved : 0n;

/** Micro-USDC → decimal string ("1.5", "0.000001"). */
export function microUsdc(raw: bigint): string {
  const whole = raw / 1_000_000n, fraction = (raw % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

/** Null when the wallet holds no shares or the supply is empty: there is no slice to show. */
export function navHeldSlice(input: NavHeldInput): NavHeldBook | null {
  if (input.shares <= 0n || input.supply <= 0n) return null;
  const shares = input.shares > input.supply ? input.supply : input.shares;
  const usdcRaw = free(input.usdcBalance, input.reservedUsdc) * shares / input.supply;
  const legs = input.legs.map(leg => {
    const amount = free(leg.balance, leg.reserved) * shares / input.supply;
    return { leg, amount, value: amount * leg.price / 10n ** BigInt(leg.decimals) };
  });
  const total = legs.reduce((sum, row) => sum + row.value, usdcRaw);
  const weight = (value: bigint) => total > 0n ? Number(value * 10_000n / total) : 0;
  return {
    legs: legs
      .map(({ leg, amount, value }) => ({ ticker: leg.ticker, mint: leg.mint, decimals: leg.decimals, amountRaw: amount.toString(), valueUsdc: microUsdc(value), weightBps: weight(value), value }))
      .sort((a, b) => (b.value > a.value ? 1 : b.value < a.value ? -1 : 0))
      .map(({ value: _value, ...row }) => { void _value; return row; }),
    usdc: { amountRaw: usdcRaw.toString(), valueUsdc: microUsdc(usdcRaw), weightBps: weight(usdcRaw) },
    totalUsdc: microUsdc(total),
    markedAt: input.markedAt ?? null,
    pricesFresh: input.pricesFresh ?? false,
  };
}

/** Human token amount from raw units: grouped whole part, up to 6 decimals, never a fake zero. */
export function tokenAmountText(amountRaw: string, decimals: number): string {
  if (!/^(0|[1-9][0-9]*)$/.test(amountRaw) || !Number.isInteger(decimals) || decimals < 0) return "—";
  const raw = BigInt(amountRaw);
  if (raw === 0n) return "0";
  const scale = 10n ** BigInt(decimals);
  const shown = Math.min(decimals, 6);
  const whole = raw / scale;
  const fraction = (raw % scale).toString().padStart(decimals, "0").slice(0, shown).replace(/0+$/, "");
  if (whole === 0n && !fraction) return `<0.${"0".repeat(Math.max(shown - 1, 0))}1`;
  const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return fraction ? `${grouped}.${fraction}` : grouped;
}

/** "24.5%" from basis points. */
export function weightText(weightBps: number): string {
  return `${(weightBps / 100).toFixed(1)}%`;
}
