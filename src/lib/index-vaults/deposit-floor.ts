/**
 * Cent-rounded Mag7 allocation plus live SOL transaction-fee allowance. The measurement and
 * reproducible per-leg/10-stock method are recorded in docs/mag7-deposit-minimum.md.
 */
export const PUBLIC_DEPOSIT_MINIMUM_USDC = "0.03";
export const PUBLIC_DEPOSIT_MINIMUM_USDC_RAW = "30000";

export function publicDepositMinimumMessage() {
  return `Minimum is $${PUBLIC_DEPOSIT_MINIMUM_USDC}.`;
}
