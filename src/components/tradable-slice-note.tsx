import { navSliceLabel, type VaultReadiness } from "@/lib/frontend/vault-api";

/** Honest label for a NAV vault: it holds the tradable slice of the disclosed book, not every name. */
export function TradableSliceNote({ readiness, className }: { readiness?: VaultReadiness | null; className?: string }) {
  const label = navSliceLabel(readiness);
  if (!label) return null;
  const excluded = readiness?.slice?.excluded ?? [];
  return <div className={className} data-tradable-slice="true">
    <strong>{label}</strong>
    {excluded.length ? <details>
      <summary>{excluded.length} disclosed {excluded.length === 1 ? "name is" : "names are"} not in the vault</summary>
      <ul>{excluded.map(item => <li key={`${item.ticker}-${item.reason}`}>{item.ticker} — {item.reason}</li>)}</ul>
    </details> : null}
  </div>;
}
