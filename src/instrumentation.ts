/**
 * Server start hook. Warm the disclosure caches so the first Discover render
 * after a deploy does not wait on the full EDGAR crawl (~250 paced requests).
 * Fire-and-forget: `register` must not block readiness.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.STOCKLANA_SKIP_WARMUP === "1") return;
  const { warmDisclosureTape } = await import("@/lib/fomo/catalog");
  warmDisclosureTape();
}
