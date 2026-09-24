/**
 * After a signed NAV deposit or cash-out confirms, every mounted position view (position page,
 * Positions list, index-page position) must refetch at once and keep re-reading until the chain
 * shows the new share balance. Pure and timer-injectable so the node tests can drive it.
 *
 * Nothing here invents a balance: a change is "reflected" only when a position read observes it.
 */
import { sharesDecreasedAfterSignature, sharesIncreasedAfterSignature } from "./settlement-progress.ts";

/** Re-read cadence while a confirmed signature is not yet visible in the position read. */
export const POSITION_REFRESH_POLL_MS = 3_000;
/** Stop polling this long after the signature confirmed; focus and the next change still refetch. */
export const POSITION_REFRESH_WINDOW_MS = 30_000;

export type PositionChange = {
  indexId: string;
  owner: string;
  mode: "deposit" | "withdraw";
  /** The wallet's share balance read before it signed. */
  sharesBeforeRaw: string;
  signature?: string;
  /** Epoch ms when the signature confirmed. */
  at: number;
};

type ShareRead = { sharesRaw: string } | null | undefined;

export async function readSharesBeforeSignature(load: () => Promise<ShareRead>, cached: ShareRead): Promise<string> {
  try {
    return (await load())?.sharesRaw ?? "0";
  } catch {
    return cached?.sharesRaw ?? "0";
  }
}

/** True once a position read shows the share balance moved the way the confirmed signature must move it. */
export function changeReflected(change: Pick<PositionChange, "mode" | "sharesBeforeRaw">, position: ShareRead): boolean {
  if (!position) return false;
  return change.mode === "deposit"
    ? sharesIncreasedAfterSignature(change.sharesBeforeRaw, position)
    : sharesDecreasedAfterSignature(change.sharesBeforeRaw, position);
}

/** A Positions-list read omits indexes where the wallet holds nothing, so absence is a zero balance. */
export function positionInList(positions: readonly { indexId: string; sharesRaw: string }[] | null | undefined, indexId: string): ShareRead {
  if (!positions) return null;
  return positions.find(position => position.indexId === indexId) ?? { sharesRaw: "0" };
}

type Listener = (change: PositionChange) => void;
const listeners = new Set<Listener>();
let recent: PositionChange[] = [];

function live(now: number, windowMs = POSITION_REFRESH_WINDOW_MS) {
  recent = recent.filter(change => now - change.at < windowMs);
  return recent;
}

/**
 * VaultFlow calls this once the wallet transaction confirms. Mounted views refetch immediately; a view
 * mounted later in the same tab (e.g. navigating to Positions) picks the change up from `pendingPositionChanges`.
 */
export function announcePositionChange(change: PositionChange): void {
  recent = [...live(change.at).filter(existing => !(existing.indexId === change.indexId && existing.owner === change.owner)), change];
  for (const listener of [...listeners]) listener(change);
}

export function subscribePositionChanges(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Confirmed changes for this wallet within the refresh window. */
export function pendingPositionChanges(owner: string, now = Date.now()): PositionChange[] {
  return live(now).filter(change => change.owner === owner);
}

/** Test hook. */
export function resetPositionChanges(): void {
  recent = [];
  listeners.clear();
}

export type Timers = {
  setTimeout: (callback: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  now: () => number;
};

const realTimers: Timers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};

export type PositionRefresherOptions<T> = {
  /** Read the view's positions. Rejections are retried on the next tick. */
  load: () => Promise<T>;
  /** Hand every fresh read to the view (also reads taken while nothing is pending). */
  apply: (value: T) => void;
  /** Whether this read shows the confirmed change. */
  reflected: (value: T, change: PositionChange) => boolean;
  /** Which changes this view shows (wallet and, for single-index views, index). */
  accepts: (change: PositionChange) => boolean;
  /** Index ids whose numbers are awaiting a confirmed change; empty when up to date. */
  onUpdating: (indexIds: string[]) => void;
  pollMs?: number;
  windowMs?: number;
  timers?: Timers;
};

/**
 * Drives one view: `track` a confirmed change -> read now, then every `pollMs` until every tracked change
 * is reflected or `windowMs` after its confirmation passed. `refetch` is a single read (window focus).
 */
export function createPositionRefresher<T>(options: PositionRefresherOptions<T>) {
  const timers = options.timers ?? realTimers;
  const pollMs = options.pollMs ?? POSITION_REFRESH_POLL_MS;
  const windowMs = options.windowMs ?? POSITION_REFRESH_WINDOW_MS;
  let pending: PositionChange[] = [];
  let timer: unknown = null;
  let inflight: Promise<void> | null = null;
  let queued = false;
  let disposed = false;
  let lastUpdating = "";

  function report() {
    const ids = [...new Set(pending.map(change => change.indexId))];
    const key = ids.join(",");
    if (key === lastUpdating) return;
    lastUpdating = key;
    options.onUpdating(ids);
  }
  function expire() {
    const now = timers.now();
    pending = pending.filter(change => now - change.at < windowMs);
  }
  function schedule() {
    if (timer !== null) { timers.clearTimeout(timer); timer = null; }
    if (disposed || !pending.length) return;
    timer = timers.setTimeout(() => { timer = null; void read(); }, pollMs);
  }
  function read(): Promise<void> {
    if (disposed) return Promise.resolve();
    // One read at a time; a request made while one is in flight runs right after it.
    if (inflight) { queued = true; return inflight; }
    if (timer !== null) { timers.clearTimeout(timer); timer = null; }
    inflight = options.load().then(value => {
      if (disposed) return;
      options.apply(value);
      const seen = pending.filter(change => options.reflected(value, change));
      pending = pending.filter(change => !seen.includes(change));
    }, () => { /* keep polling: a failed read is not an observation */ }).finally(() => {
      inflight = null;
      if (disposed) return;
      expire();
      report();
      if (queued) { queued = false; void read(); } else schedule();
    });
    return inflight;
  }
  return {
    track(change: PositionChange) {
      if (disposed || !options.accepts(change)) return;
      pending = [...pending.filter(existing => !(existing.indexId === change.indexId && existing.owner === change.owner)), change];
      expire();
      report();
      if (pending.length) void read();
    },
    /** One read (window focus). Joins a read already in flight: focus and visibilitychange fire together. */
    refetch: () => inflight ?? read(),
    updating: () => pending.map(change => change.indexId),
    dispose() {
      disposed = true;
      if (timer !== null) timers.clearTimeout(timer);
      timer = null;
      pending = [];
    },
  };
}
