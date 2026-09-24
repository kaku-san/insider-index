/**
 * Keeper RPC pacing: one JSON-RPC request in flight at a time, a minimum gap between requests, and
 * exponential backoff (honouring `Retry-After`) on HTTP 429. Pass as `new Connection(url, { fetch,
 * disableRetryOnRateLimit: true })` so web3.js does not stack its own 500 ms retry storm on top.
 * No env, no `@/` aliases.
 */
export type ThrottleOptions = {
  /** Minimum milliseconds between request starts (default 125 ms ≈ 8 req/s). */
  minIntervalMs?: number;
  /** Retries after a 429 before the 429 response is returned (default 6). */
  maxRetries?: number;
  /** First backoff delay; doubles per retry up to `maxBackoffMs` (defaults 500 ms / 8 s). */
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  onRateLimited?: (attempt: number, delayMs: number) => void;
};

export function throttledFetch(options: ThrottleOptions = {}): typeof fetch {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const minInterval = options.minIntervalMs ?? 125;
  const maxRetries = options.maxRetries ?? 6;
  const base = options.baseBackoffMs ?? 500;
  const maxBackoff = options.maxBackoffMs ?? 8_000;
  let queue: Promise<unknown> = Promise.resolve();
  let lastStart = -Infinity;
  const paced = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    for (let attempt = 0; ; attempt++) {
      const wait = lastStart + minInterval - now();
      if (wait > 0) await sleep(wait);
      lastStart = now();
      const response = await fetchImpl(input, init);
      if (response.status !== 429 || attempt >= maxRetries) return response;
      const retryAfter = Number(response.headers.get("retry-after"));
      const delay = Math.min(maxBackoff, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : base * 2 ** attempt);
      options.onRateLimited?.(attempt + 1, delay);
      await sleep(delay);
    }
  };
  return ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const run = queue.then(() => paced(input, init));
    queue = run.catch(() => undefined);
    return run;
  }) as typeof fetch;
}
