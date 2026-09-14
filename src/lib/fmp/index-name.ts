import type { Person } from "./types.ts";

type IndexPerson = Pick<Person, "id" | "name" | "firstName" | "lastName">;

/** Shared display / future vault metadata name. Never accepts a user-chosen label. */
export function baseIndexName(person: IndexPerson): string {
  const words = person.name.trim().split(/\s+/).filter(Boolean);
  const first = person.firstName?.trim().split(/\s+/)[0] || words[0] || "Unknown";
  const last = person.lastName?.trim() || (words.length > 1 ? words.at(-1)! : "");
  const initial = Array.from(last)[0]?.toLocaleUpperCase("en-US");
  return `${first}${initial ? ` ${initial}` : ""} Index`;
}

/** Collision checks use the full saved directory, before any search or pagination. */
export function indexNames(people: readonly IndexPerson[]): Map<string, string> {
  const groups = new Map<string, Set<string>>();
  for (const person of people) {
    const base = baseIndexName(person).toLocaleLowerCase("en-US");
    const ids = groups.get(base) ?? new Set<string>();
    ids.add(person.id);
    groups.set(base, ids);
  }
  return new Map(people.map((person) => {
    const base = baseIndexName(person);
    return [person.id, groups.get(base.toLocaleLowerCase("en-US"))!.size > 1 ? `${base} · ${person.id}` : base];
  }));
}
