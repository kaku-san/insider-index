import type { MoneyBand, ResearchPerson } from "./research-contract";

export function moneyBand(value?: MoneyBand | null) {
  const low = value?.low;
  const high = value?.high;
  const money = (n: number) => n >= 1_000_000 ? `$${(n / 1_000_000).toLocaleString("en-US", { maximumFractionDigits: 1 })}M`
    : n >= 1_000 ? `$${(n / 1_000).toLocaleString("en-US", { maximumFractionDigits: 0 })}K`
      : `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
  if (typeof low === "number" && typeof high === "number") return low === high ? money(low) : `${money(low)}–${money(high)}`;
  if (typeof low === "number") return `${money(low)}+`;
  if (typeof high === "number") return `≤${money(high)}`;
  return "Range unavailable";
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
