type SearchablePerson = { name: string; id: string; party: string | null; state: string | null; chamber: string };

/** Search the full saved directory before applying the UI's display limit. */
export function filterPeople<T extends SearchablePerson>(people: T[], query: string, chamber: string): T[] {
  const needle = query.trim().toLowerCase();
  return people.filter((person) => (chamber === "all" || person.chamber === chamber) &&
    [person.name, person.id, person.party, person.state].filter(Boolean).join(" ").toLowerCase().includes(needle));
}

export function bookStatus(state: string): string {
  const labels: Record<string, string> = {
    "not-ingested": "Book pending",
    "no-annual-book": "No annual book saved",
    "partial-disclosure-only": "Partial disclosure",
    "complete": "Source complete",
  };
  return labels[state] ?? state.replaceAll("-", " ");
}

export function personContext(person: { chamber: string; state: string | null; party: string | null }): string {
  const chamber = person.chamber === "house" ? "House" : person.chamber === "senate" ? "Senate" : "Chamber unknown";
  return [chamber, person.state, person.party].filter(Boolean).join(" · ");
}

export function disclosedRange({ low, high }: { low: number | null; high: number | null }): string {
  const usd = (value: number) => value.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
  if (low === null && high === null) return "Not disclosed";
  if (low === null) return `Up to ${usd(high!)}`;
  if (high === null) return `${usd(low)}+`;
  return low === high ? usd(low) : `${usd(low)}–${usd(high)}`;
}
