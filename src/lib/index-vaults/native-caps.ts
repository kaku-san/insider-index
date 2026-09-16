import { MAX_SUPPORTED_TOKENS_PER_VAULT, MAX_TRANSFER_TOKENS, UPDATE_TOKEN_PRICES_MAX_ACCOUNTS } from "@symmetry-hq/sdk/dist/constants.js";

/** Program layout caps. "Hundreds of names" cannot be one vault; 100 is the ceiling. */
export const NATIVE_CAPS = Object.freeze({
  maxTokensPerVault: MAX_SUPPORTED_TOKENS_PER_VAULT,
  maxTransferTokens: MAX_TRANSFER_TOKENS,
  priceUpdateMaxAccounts: UPDATE_TOKEN_PRICES_MAX_ACCOUNTS,
  /** Conservative CLMM grouping; CPMM can fit ~12. Never claim more. */
  priceUpdateTokensPerTx: 10,
});

export function discloseNativeCaps(tokenCount: number) {
  if (!Number.isInteger(tokenCount) || tokenCount < 0) throw new Error("Token count required");
  if (tokenCount > NATIVE_CAPS.maxTokensPerVault) throw new Error(`NATIVE_TOKEN_CAP: one vault holds at most ${NATIVE_CAPS.maxTokensPerVault} tokens; ${tokenCount} does not fit`);
  const priceTx = tokenCount === 0 ? 0 : Math.ceil(tokenCount / NATIVE_CAPS.priceUpdateTokensPerTx);
  const redeemTx = tokenCount === 0 ? 0 : Math.ceil(tokenCount / NATIVE_CAPS.maxTransferTokens);
  return {
    ...NATIVE_CAPS,
    tokens: tokenCount,
    priceUpdateTransactions: priceTx,
    redeemTransferTransactions: redeemTx,
    hundredsOfNames: "impossible-in-one-vault" as const,
  };
}
