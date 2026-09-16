/**
 * Politicians whose public disclosure carries no mappable position book, so no
 * InsiderIndex person index (the fundable, vault-candidate annual-holdings model)
 * is published for them. Their person pages stay live with an honest explanation
 * instead of a dead end or a half-built index; the ten thematic research indexes
 * fill the index lineup in their place.
 *
 * Frontend-only reference: this describes what the person-index-map / FMP annual
 * mapping produced, it does not drive any mapping, vault, or database behaviour.
 */
export type NoIndexReason = "no-holdings-book" | "trades-only";

export type NoIndexPerson = {
  /** Bioguide id used on /p/[id] and the tracker snapshot. */
  id: string;
  name: string;
  reason: NoIndexReason;
};

/** No ticker-bearing holdings in the annual filing → no holdings book to map. */
const NO_HOLDINGS_BOOK: NoIndexPerson[] = [
  { id: "K000383", name: "Angus S. King Jr.", reason: "no-holdings-book" },
  { id: "S001198", name: "Dan Sullivan", reason: "no-holdings-book" },
  { id: "S001217", name: "Rick Scott", reason: "no-holdings-book" },
  { id: "C001047", name: "Shelley Moore Capito", reason: "no-holdings-book" },
  { id: "B001305", name: "Ted Budd", reason: "no-holdings-book" },
  { id: "M001236", name: "Tim Moore", reason: "no-holdings-book" },
];

/** Only trades disclosed, never a holdings book → nothing to weight into an index. */
const TRADES_ONLY: NoIndexPerson[] = [
  { id: "G000603", name: "Brandon Gill", reason: "trades-only" },
  { id: "F000110", name: "Cleo Fields", reason: "trades-only" },
  { id: "C001123", name: "Gilbert Ray Cisneros, Jr.", reason: "trades-only" },
  { id: "S001229", name: "Jefferson Shreve", reason: "trades-only" },
];

export const NO_INDEX_PEOPLE: NoIndexPerson[] = [...NO_HOLDINGS_BOOK, ...TRADES_ONLY];

const BY_ID = new Map(NO_INDEX_PEOPLE.map((person) => [person.id, person]));

/** True when this bioguide id has no published InsiderIndex person index. */
export function personIndexUnavailable(id: string): boolean {
  return BY_ID.has(id);
}

export function noIndexReason(id: string): NoIndexPerson | null {
  return BY_ID.get(id) ?? null;
}

/** Honest, copy-safe one-liner explaining why no person index exists. */
export function noIndexExplanation(person: NoIndexPerson): string {
  return person.reason === "trades-only"
    ? `${person.name}'s public disclosure lists trades only — never a holdings book — so InsiderIndex publishes no person index for them. Nothing is invented to fill the gap.`
    : `${person.name}'s public annual filing carries no ticker-bearing holdings, so there is no position book to map into an InsiderIndex person index. Nothing is invented to fill the gap.`;
}
