import type { MoneyBand, ResearchPerson } from "./research-contract";

export function moneyBand(value?: MoneyBand | null) {
  const validBound = (bound?: number | null) => typeof bound === "number" && Number.isFinite(bound) && bound > 0 ? bound : null;
  const low = validBound(value?.low);
  const high = validBound(value?.high);
  const money = (n: number) => n >= 1_000_000 ? `$${(n / 1_000_000).toLocaleString("en-US", { maximumFractionDigits: 1 })}M`
    : n >= 1_000 ? `$${(n / 1_000).toLocaleString("en-US", { maximumFractionDigits: 0 })}K`
      : `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
  if (low !== null && high !== null) return low > high ? "Range unavailable" : low === high ? money(low) : `${money(low)}–${money(high)}`;
  if (low !== null) return `${money(low)}+`;
  if (high !== null) return `≤${money(high)}`;
  return "Range unavailable";
}

const STOCK_ACT_BANDS: ReadonlyArray<readonly [number, number]> = [
  [1_001, 2_500],
  [2_501, 5_000],
  [5_001, 15_000],
  [1_001, 15_000],
  [15_001, 50_000],
  [50_001, 100_000],
  [100_001, 250_000],
  [250_001, 500_000],
  [500_001, 1_000_000],
  [1_000_001, 5_000_000],
  [5_000_001, 25_000_000],
  [25_000_001, 50_000_000],
];

export function stockActBandFromMidpoint(midpoint?: number | null): MoneyBand {
  if (typeof midpoint !== "number" || !Number.isFinite(midpoint)) return { low: null, high: null };
  const match = STOCK_ACT_BANDS.find(([low, high]) => Math.abs((low + high) / 2 - midpoint) < 0.01);
  return match ? { low: match[0], high: match[1] } : { low: null, high: null };
}

export function shortDate(value?: string | null) {
  if (!value) return "Date unavailable";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

export function personContext(person: ResearchPerson) {
  const office = person.office ?? person.position;
  const bits = [office, person.state, person.chamber && person.chamber !== "unknown" ? person.chamber : null].filter(Boolean);
  return bits.join(" · ") || "Public disclosure record";
}

export function slugifyPerson(name: string) {
  return name.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export function markedDollars(value?: string | null) {
  if (typeof value !== "string" || !value.trim()) return "—";
  const amount = Number(value);
  return Number.isFinite(amount) ? amount.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }) : "—";
}
