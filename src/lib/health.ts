/** Boolean adapter probes only. Never return secret values or key fragments. */

export type AdapterStatus = {
  form4: boolean;
  jupiter: boolean;
  helius: boolean;
  privy: boolean;
  supabase: boolean;
};

function present(value: string | undefined): boolean {
  return Boolean(value?.trim());
}

export function getAdapterStatus(): AdapterStatus {
  return {
    form4: present(process.env.FORM4API_KEY),
    jupiter: present(process.env.JUPITER_API_KEY),
    helius: present(process.env.HELIUS_API_KEY),
    privy: present(process.env.NEXT_PUBLIC_PRIVY_APP_ID) || present(process.env.NEXT_PUBLIC_PRIVY_APPID),
    supabase:
      present(process.env.NEXT_PUBLIC_SUPABASE_URL) &&
      present(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY),
  };
}
