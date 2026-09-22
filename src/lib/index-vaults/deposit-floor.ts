/** Public deposits below this amount create dust that cannot be settled reliably. */
export const PUBLIC_DEPOSIT_MINIMUM_USDC = "250";
export const PUBLIC_DEPOSIT_MINIMUM_USDC_RAW = "250000000";

export function publicDepositMinimumMessage() {
  return `Minimum deposit is $${PUBLIC_DEPOSIT_MINIMUM_USDC}.`;
}
