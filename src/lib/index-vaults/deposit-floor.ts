/**
 * Public in-kind zap floor for every deposits-enabled index. $10 is the product minimum,
 * not proof a later route still fills. See docs/mag7-deposit-minimum.md.
 */
export const PUBLIC_DEPOSIT_MINIMUM_USDC = "10";
export const PUBLIC_DEPOSIT_MINIMUM_USDC_RAW = "10000000";

export function publicDepositMinimumMessage() {
  return `Minimum is $${PUBLIC_DEPOSIT_MINIMUM_USDC}.`;
}
