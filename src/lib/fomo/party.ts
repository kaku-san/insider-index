import type { PoliticalParty } from "@/lib/disclosures/types";

export function normalizeParty(value: string | null | undefined): PoliticalParty | null {
  if (!value) return null;
  const raw = value.trim().toLowerCase();
  if (raw === "d" || raw.startsWith("democrat")) return "Democratic";
  if (raw === "r" || raw.startsWith("republican")) return "Republican";
  if (raw.startsWith("ind")) return "Independent";
  return null;
}

export function partyAccent(party: PoliticalParty | null): string {
  if (party === "Democratic") return "text-sky-300";
  if (party === "Republican") return "text-rose-300";
  return "text-zinc-300";
}

export function partyChip(party: PoliticalParty | null): string {
  if (party === "Democratic") return "bg-sky-500/15 text-sky-200 ring-sky-500/30";
  if (party === "Republican") return "bg-rose-500/15 text-rose-200 ring-rose-500/30";
  return "bg-white/10 text-zinc-200 ring-white/10";
}
