/**
 * Smallest measured public Mag7 deposit candidate whose weighted slices all have a live
 * Raydium route at the keeper's 50 bps slippage. See docs/mag7-deposit-minimum.md.
 */
export const PUBLIC_DEPOSIT_MINIMUM_USDC = "1";
export const PUBLIC_DEPOSIT_MINIMUM_USDC_RAW = "1000000";

export function publicDepositMinimumMessage() {
  return `Minimum is $${PUBLIC_DEPOSIT_MINIMUM_USDC}.`;
}
