/**
 * Small in-process memo cache with TTL, in-flight dedupe, stale-on-error, and
 * stale-while-revalidate. Upstream disclosure feeds (EDGAR, AInvest) are slow
 * and rate-limited, so one page view must never fan out to hundreds of fetches
 * and a refresh must never block a render that already has good data.
 */

type Entry<T> = {
  value: T;
  expiresAt: number;
};

/**
 * Next bundles server code separately for route handlers, SSR, and
 * instrumentation, so a plain module-level Map would exist three times in one
 * process. Anchor shared state on globalThis so every bundle sees one cache
 * (and one EDGAR pacer).
 */
export function globalState<T>(key: string, init: () => T): T {
  const root = globalThis as unknown as Record<string, T | undefined>;
  const name = `__stocklana_${key}`;
  if (root[name] === undefined) {
    root[name] = init();
  }
  return root[name] as T;
}

const store = globalState("memo_store", () => new Map<string, Entry<unknown>>());
const inflight = globalState("memo_inflight", () => new Map<string, Promise<unknown>>());

export type MemoOptions = {
  /** Fresh window. Use Number.POSITIVE_INFINITY for immutable payloads. */
  ttlMs: number;
  /** Serve the last good value if the loader throws. Default true. */
  staleOnError?: boolean;
  /** Return the stale value immediately and refresh in the background. Default true. */
  staleWhileRevalidate?: boolean;
};

function startLoad<T>(key: string, options: MemoOptions, loader: () => Promise<T>, previous?: Entry<T>): Promise<T> {
  const pending = inflight.get(key) as Promise<T> | undefined;
  if (pending) return pending;

  const run = (async () => {
    try {
      const value = await loader();
      store.set(key, { value, expiresAt: Date.now() + options.ttlMs });
      return value;
    } catch (error) {
      if ((options.staleOnError ?? true) && previous) {
        // Keep the stale value for a short grace period so a flapping upstream
        // does not trigger a retry on every render.
        store.set(key, {
          value: previous.value,
          expiresAt: Date.now() + Math.min(options.ttlMs, 60_000),
        });
        return previous.value;
      }
      throw error;
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, run);
  return run;
}

export async function memo<T>(
  key: string,
  options: MemoOptions,
  loader: () => Promise<T>,
): Promise<T> {
  const now = Date.now();
  const hit = store.get(key) as Entry<T> | undefined;
  if (hit && hit.expiresAt > now) {
    return hit.value;
  }

  if (hit && (options.staleWhileRevalidate ?? true)) {
    void startLoad(key, options, loader, hit).catch(() => undefined);
    return hit.value;
  }

  return startLoad(key, options, loader, hit);
}

export function memoPeek<T>(key: string): T | undefined {
  return (store.get(key) as Entry<T> | undefined)?.value;
}

export function memoClear(prefix?: string): void {
  if (!prefix) {
    store.clear();
    return;
  }
  for (const key of [...store.keys()]) {
    if (key.startsWith(prefix)) store.delete(key);
  }
}

/** Run tasks with at most `limit` in flight. Preserves input order. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await task(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}
