import { PublicKey } from "@solana/web3.js";
import type { AddOrEditTokenInput, Vault } from "@symmetry-hq/sdk";
import { nativeDefaultInput, NATIVE_DEFAULT_BINDINGS, MAINNET_USDC } from "../../src/lib/index-vaults/native-defaults.ts";
import { KAKU_SAN_DEPLOYER } from "../../src/lib/index-vaults/kaku-san.ts";
import { RAYDIUM_ORACLE_KINDS } from "../../src/lib/index-vaults/raydium-oracles.ts";

/** Synthetic verifier fixture, NOT evidence of native execution. The deployed-program VM tests
 * separately prove builder -> native post-state. This models fully installed oracle settings
 * rather than old impossible empty-oracle/inactive-WSOL mocks. */
export function installedCompositionFixture(vault: string, share: string, legs: { token: AddOrEditTokenInput; targetWeightBps: number }[]): Vault {
  const tokens = [...NATIVE_DEFAULT_BINDINGS.map(b => ({ token: nativeDefaultInput(b.mint), targetWeightBps: 0 })), ...legs];
  const composition = tokens.map(({ token, targetWeightBps }, index) => {
    const oracle = token.oracles[0];
    return { mint: new PublicKey(token.token_mint), active: Number(token.active), amount: 0n, weight: targetWeightBps,
      oracleAggregator: { numOracles: 1, minOraclesThresh: 1, minConfBps: 50, confThreshBps: 200, confMultiplier: { high: 1n, low: 0n }, oracles: [{
        oracleSettings: { oracleType: RAYDIUM_ORACLE_KINDS[oracle.oracle_type as keyof typeof RAYDIUM_ORACLE_KINDS], numRequiredAccounts: 1,
          weight: 10000, isRequired: 1, confThreshBps: 9999, volatilityThreshBps: 9999, maxSlippageBps: 9999,
          minLiquidity: 0n, stalenessThresh: 3600n, stalenessConfRateBps: 0, tokenDecimals: oracle.token_decimals,
          twapSecondsAgo: 30n, twapSecondarySecondsAgo: 120n, quote: oracle.quote_token === "wsol" ? 1 : 0, side: token.token_mint === MAINNET_USDC ? 1 : 0 },
        accountsToLoadLutIds: [0], accountsToLoadLutIndices: [index],
      }] },
    };
  });
  return { ownAddress: new PublicKey(vault), mint: new PublicKey(share), numTokens: composition.length, composition,
    settings: { creator: new PublicKey(KAKU_SAN_DEPLOYER), activeManagements: { isZero: () => true } },
    lutPubkeys: [{ state: { addresses: tokens.map(t => new PublicKey(t.token.oracles[0].account)) } }],
  } as unknown as Vault;
}
