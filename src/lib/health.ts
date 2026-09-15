/** Boolean adapter probes only. Never return secret values or key fragments. */

import { jupiterMode, mocksAllowed } from "@/lib/runtime";

export type AdapterStatus = {
  /** SEC EDGAR needs no key; true means the crawler is enabled. */
  edgar: boolean;
  /** AInvest Congressional Trades — AINVEST_API_KEY present. */
  ainvest: boolean;
  /** Form4API fallback — FORM4API_KEY present. */
  form4: boolean;
  /** JUPITER_API_KEY present (keyless live quoting is reported under modes). */
  jupiter: boolean;
  helius: boolean;
  privy: boolean;
  supabase: boolean;
};

export type RuntimeModes = {
  insiders: "edgar" | "form4" | "mock" | "off";
  congress: "ainvest" | "form4" | "mock" | "off";
  jupiter: "live-keyed" | "live-keyless" | "stub";
  rpc: "helius" | "public";
  wallet: "privy" | "unavailable";
  mocksAllowed: boolean;
};

function present(value: string | undefined): boolean {
  return Boolean(value?.trim());
}

export function getAdapterStatus(): AdapterStatus {
  return {
    edgar: process.env.EDGAR_DISABLED?.trim() !== "1",
    ainvest: present(process.env.AINVEST_API_KEY),
    form4: present(process.env.FORM4API_KEY),
    jupiter: present(process.env.JUPITER_API_KEY),
    helius: present(process.env.HELIUS_API_KEY),
    privy: present(process.env.NEXT_PUBLIC_PRIVY_APP_ID) || present(process.env.NEXT_PUBLIC_PRIVY_APPID),
    supabase:
      present(process.env.NEXT_PUBLIC_SUPABASE_URL) &&
      present(process.env.SUPABASE_SERVICE_ROLE_KEY),
  };
}

/** Which path each lane will take, derived purely from configuration. */
export function getRuntimeModes(): RuntimeModes {
  const adapters = getAdapterStatus();
  const mocks = mocksAllowed();
  const mode = jupiterMode();
  return {
    insiders: adapters.edgar ? "edgar" : adapters.form4 ? "form4" : mocks ? "mock" : "off",
    congress: adapters.ainvest ? "ainvest" : adapters.form4 ? "form4" : mocks ? "mock" : "off",
    jupiter: mode === "stub" ? "stub" : adapters.jupiter ? "live-keyed" : "live-keyless",
    rpc: adapters.helius ? "helius" : "public",
    wallet: adapters.privy ? "privy" : "unavailable",
    mocksAllowed: mocks,
  };
}
