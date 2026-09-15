/** Device-local watchlist. No server store, alerts, or automatic execution. */
export const PERSON_FOLLOW_PREFIX = "stocklana:person-follow:";
export const PERSON_FOLLOW_EVENT = "stocklana:person-follow-changed";

export function personFollowKey(id: string): string {
  return `${PERSON_FOLLOW_PREFIX}${id}`;
}

export function isPersonFollowed(id: string): boolean {
  try { return localStorage.getItem(personFollowKey(id)) === "true"; } catch { return false; }
}

export function listFollowedPersonIds(): string[] {
  try {
    return Object.keys(localStorage)
      .filter((key) => key.startsWith(PERSON_FOLLOW_PREFIX) && localStorage.getItem(key) === "true")
      .map((key) => key.slice(PERSON_FOLLOW_PREFIX.length));
  } catch { return []; }
}

export function subscribeToPersonFollows(callback: () => void): () => void {
  window.addEventListener("storage", callback);
  window.addEventListener(PERSON_FOLLOW_EVENT, callback);
  return () => {
    window.removeEventListener("storage", callback);
    window.removeEventListener(PERSON_FOLLOW_EVENT, callback);
  };
}
