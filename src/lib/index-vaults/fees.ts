import type { GlobalConfig, Vault } from "@symmetry-hq/sdk";

export const HOST_ENTRY_FEE_BPS = 25;
export const HOST_EXIT_FEE_BPS = 0;
export function feeSnapshot(vault: Vault, global: GlobalConfig) {
  const f = vault.settings.fees;
  const otherStocklanaRates = [f.hostWithdrawFeeBps, f.hostManagementFeeBps, f.hostPerformanceFeeBps,
    f.creatorDepositFeeBps, f.creatorWithdrawFeeBps, f.creatorManagementFeeBps, f.creatorPerformanceFeeBps,
    f.managersDepositFeeBps, f.managersWithdrawFeeBps, f.managersManagementFeeBps, f.managersPerformanceFeeBps,
    f.vaultDepositFeeBps, f.vaultWithdrawFeeBps];
  return {
    host: vault.settings.host.toBase58(), hostEntryFeeBps: f.hostDepositFeeBps, hostExitFeeBps: f.hostWithdrawFeeBps,
    stocklanaFeesValid: f.hostDepositFeeBps === 25 && otherStocklanaRates.every(n => n === 0),
    protocol: { depositFlatBps: global.symmetryDepositFeeBps, depositFeeShareBps: global.symmetryDepositFeeShareBps,
      withdrawFlatBps: global.symmetryWithdrawFeeBps, withdrawFeeShareBps: global.symmetryWithdrawFeeShareBps,
      tradeBps: global.symmetryTradeFeeBps },
    accruedNativeUnits: { host: vault.accumulatedFees.hostFees.toString(), creator: vault.accumulatedFees.creatorFees.toString(),
      managers: vault.accumulatedFees.managersFees.toString(), protocol: vault.accumulatedFees.symmetryFees.toString() },
    bountyBondRaw: global.bountyBondAmount.toString(),
    representation: "native-accounting-units; not assumed immediately spendable shares or USDC",
  };
}
