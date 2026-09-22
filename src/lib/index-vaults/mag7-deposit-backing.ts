import type { Vault } from "@symmetry-hq/sdk";
import type { PersistedVaultDefinition } from "./vault-definition-store.ts";

/** Positive-supply native deposits follow actual balances, NOT configured weights.
 * Cash-only/partial books cannot acquire missing Mag7 legs through another deposit.
 * Zero-supply accounted leftovers also require reconciliation, not a new depositor. */
export function assertMag7DepositBacking(vault: Vault, definition: PersistedVaultDefinition): void {
  if (definition.indexId !== "idx-theme-mag7-caucus") return;
  const mints = definition.vaultLegs.map(leg => leg.mint);
  if (mints.length !== 7 || new Set(mints).size !== 7) throw new Error("Mag7 requires seven distinct investment legs before accepting a deposit.");
  const backing = vault.composition.slice(0, vault.numTokens);
  if (vault.supplyOutstanding.isZero()) {
    if (backing.some(token => !token.amount.isZero())) throw new Error("Mag7 has residual backing without outstanding shares; reconcile before another deposit.");
  } else if (mints.some(mint => !backing.some(token => token.mint.toBase58() === mint && !token.amount.isZero()))) {
    throw new Error("Mag7 backing is cash-only or incomplete; reconcile all seven legs before another deposit.");
  }
}
