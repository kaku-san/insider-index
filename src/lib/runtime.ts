/**
 * Runtime mode switches. Everything here is derived from env so the same build
 * can run as a fixtures-only dev server or as the live demo.
 */

function flag(value: string | undefined): boolean | null {
  const raw = value?.trim().toLowerCase();
  if (!raw) return null;
  if (raw === "1" || raw === "true" || raw === "yes" || raw === "on") return true;
  if (raw === "0" || raw === "false" || raw === "no" || raw === "off") return false;
  return null;
}

export function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

/**
 * Whether labelled mock fixtures may be served when a live source is missing
 * or fails. Default: on in development, off in production. Override with
 * STOCKLANA_ALLOW_MOCKS=1|0 in development only.
 *
 * Production never invents politicians or insiders: without a live source the
 * lane is empty and /api/disclosures reports the lane as "off".
 */
export function mocksAllowed(): boolean {
  return !isProduction() && (flag(process.env.STOCKLANA_ALLOW_MOCKS) ?? true);
}

export type JupiterMode = "live" | "stub";

/**
 * Jupiter Swap V2 /order + /execute work without an API key (rate-limited).
 * Production is always live. A key raises limits. JUPITER_MODE=live|stub forces a development mode; otherwise live
 * when a key is present or in production, stub in development.
 */
export function jupiterMode(): JupiterMode {
  if (isProduction()) return "live";
  const forced = process.env.JUPITER_MODE?.trim().toLowerCase();
  if (forced === "live" || forced === "stub") return forced;
  if (process.env.JUPITER_API_KEY?.trim()) return "live";
  return isProduction() ? "live" : "stub";
}

/**
 * SEC EDGAR requires a descriptive User-Agent with contact info
 * (https://www.sec.gov/os/accessing-edgar-data). Override with SEC_EDGAR_USER_AGENT.
 */
export function edgarUserAgent(): string {
  return (
    process.env.SEC_EDGAR_USER_AGENT?.trim() ||
    "InsiderIndex/1.0 (https://insiderindex.xyz; ops@barelystable.dev)"
  );
}
