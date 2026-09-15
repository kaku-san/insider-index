import { address } from "./amounts.ts";
import { indexCatalog, preferredToken, type CatalogToken } from "../venues/catalog-parse.ts";

/** Vault legs are catalog tokens: xStock preferred, verified Backpack `.US` when there is no xStock. No DEX lookalikes. */
export type VaultLegProvider = "xstocks" | "backpack";
export interface AdmittedVaultLeg {
  mint: string;
  ticker: string;
  symbol: string;
  provider: VaultLegProvider;
}

function providerFor(token: CatalogToken): VaultLegProvider {
  if (token.issuer === "xstock") return "xstocks";
  if (token.issuer === "backpack") return "backpack";
  throw new Error(`DEX_LOOKALIKE_FORBIDDEN: issuer ${String((token as { issuer: unknown }).issuer)} is not xStock or Backpack`);
}

function canonicalCatalog(catalog: readonly CatalogToken[]): CatalogToken[] {
  return catalog.map(token => ({ ...token, mint: address(token.mint) }));
}

export function admitVaultLeg(mint: string, catalog: readonly CatalogToken[]): AdmittedVaultLeg {
  const canonical = address(mint);
  const index = indexCatalog(canonicalCatalog(catalog));
  const token = index.byMint.get(canonical);
  if (!token) throw new Error(`DEX_LOOKALIKE_FORBIDDEN: ${canonical} is not an xStock or Backpack .US mint`);
  const provider = providerFor(token);
  if (provider === "backpack" && !token.symbol.endsWith(".US")) throw new Error(`DEX_LOOKALIKE_FORBIDDEN: ${token.symbol} is not a Backpack .US token`);
  const preferred = preferredToken(index, token.ticker);
  if (!preferred || preferred.mint !== canonical) throw new Error(`XSTOCK_PREFERRED: ${token.ticker} has an xStock mint; do not use Backpack or a lookalike`);
  return { mint: canonical, ticker: token.ticker, symbol: token.symbol, provider };
}

export function admitVaultLegs(mints: readonly string[], catalog: readonly CatalogToken[]): AdmittedVaultLeg[] {
  if (!catalog.length) throw new Error("CATALOG_REQUIRED: vault legs need the xStock/Backpack catalog");
  return mints.map(mint => admitVaultLeg(mint, catalog));
}
