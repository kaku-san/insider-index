/** Display name for an index ("Nancy P Index"), without the " · InsiderIndex" brand suffix stored on person indexes. */
export function indexDisplayName(name: string | null | undefined): string | null {
  const text = name?.replace(/\s*·\s*InsiderIndex\s*$/, "").trim();
  return text || null;
}
