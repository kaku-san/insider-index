export type Follow = {
  wallet: string;
  profileId: string;
  autoCopy: boolean;
  createdAt: string;
};

type GlobalFollows = typeof globalThis & {
  __stocklanaFollows?: Follow[];
};

function memoryStore(): Follow[] {
  const globalRef = globalThis as GlobalFollows;
  if (!globalRef.__stocklanaFollows) {
    globalRef.__stocklanaFollows = [];
  }
  return globalRef.__stocklanaFollows;
}

export function listFollows(wallet?: string): Follow[] {
  const rows = memoryStore();
  return wallet ? rows.filter((row) => row.wallet === wallet) : [...rows];
}

export function upsertFollow(input: {
  wallet: string;
  profileId: string;
  autoCopy: boolean;
}): Follow {
  const rows = memoryStore();
  const existing = rows.find(
    (row) => row.wallet === input.wallet && row.profileId === input.profileId,
  );
  if (existing) {
    existing.autoCopy = input.autoCopy;
    return existing;
  }
  const row: Follow = {
    ...input,
    createdAt: new Date().toISOString(),
  };
  rows.unshift(row);
  return row;
}

export function unfollow(wallet: string, profileId: string): void {
  const rows = memoryStore();
  const next = rows.filter((row) => !(row.wallet === wallet && row.profileId === profileId));
  (globalThis as GlobalFollows).__stocklanaFollows = next;
}
