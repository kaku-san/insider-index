/** Fixture wallet used by the stub Privy provider. Never a real signer. */
export const STUB_WALLET_ADDRESS = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU" as const;

export function isStubWallet(address: string | null | undefined): boolean {
  return address === STUB_WALLET_ADDRESS;
}
