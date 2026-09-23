/**
 * NAV vault prepares are refused while the keeper's marks are stale (or posted this slot). The UI
 * waits for the next mark and re-prepares instead of showing an error; the wallet only opens with a
 * freshly prepared transaction.
 */
export const NAV_RETRY_DELAY_MS = 5_000;
export const NAV_RETRY_MAX_WAIT_MS = 150_000;

export function isNavStalePriceError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return /prices are stale|refreshed this slot/i.test(message);
}

export async function prepareWithStaleRetry<T>(work: () => Promise<T>, options: { alive?: () => boolean; delayMs?: number; maxWaitMs?: number; sleep?: (ms: number) => Promise<void> } = {}): Promise<T> {
  const delay = options.delayMs ?? NAV_RETRY_DELAY_MS;
  const deadline = Date.now() + (options.maxWaitMs ?? NAV_RETRY_MAX_WAIT_MS);
  const sleep = options.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
  for (;;) {
    try { return await work(); }
    catch (error) {
      if (!isNavStalePriceError(error) || Date.now() + delay > deadline || (options.alive && !options.alive())) throw error;
      await sleep(delay);
    }
  }
}
