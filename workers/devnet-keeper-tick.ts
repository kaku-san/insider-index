import { PublicKey } from "@solana/web3.js";
import type { VaultIdentity } from "../src/lib/index-vaults/adapter-contract.ts";
import { Journal } from "../src/lib/index-vaults/journal.ts";
import { rawAmount } from "../src/lib/index-vaults/amounts.ts";
import { GENESIS, NativeVaultBuilders, readOnlyConnection, SYMMETRY_PROGRAM_ID } from "../src/lib/index-vaults/symmetry-adapter.ts";
import { readKeeperObservation } from "./stocklana-keeper.ts";
import type { KeeperObservation } from "./stocklana-keeper.ts";
import { evaluateExecutionTestStrategyTick } from "./strategy-service.ts";
import type { StrategyTickInput } from "./strategy-service.ts";

// Historical creation/lock receipts: evidence/vaults/DEVNET_TEST_VAULT.md.
// Explicit observation scope only. This does not publish/register an execution-approved index.
export const DEVNET_KEEPER_IDENTITY: Readonly<VaultIdentity> = Object.freeze({
  network: "devnet", programId: SYMMETRY_PROGRAM_ID,
  vaultAccount: "Jh7cFNUT5FrtBwKakApsc3Gg5aTQjsZtYxa4dbrCoB8",
  shareMint: "Cdxoni8uv7FrqVfeHJ6YC4DeXs3QQ2uG4nT3BDd9Ny2A", shareDecimals: 6,
  hostTreasury: "C7ye6UvJ7jirwCmt3fKmt55MvcW9yBVpgqzZzgCWYQyB",
  initialDeployer: "C7ye6UvJ7jirwCmt3fKmt55MvcW9yBVpgqzZzgCWYQyB",
  indexId: "execution-test-stocklana-devnet", deploymentGeneration: 1, metadataHash: "unverified:test-metadata-only",
});
export const DEVNET_KEEPER_RPC = "https://api.devnet.solana.com";
/** Deliberately read-only dependency surface; no builders, signer, sender or configurable RPC. */
export interface DevnetTickReader {
  network: string;
  genesis(): Promise<string>;
  observe(previous?: KeeperObservation): Promise<KeeperObservation>;
  balance(): Promise<{ slot: number; lamports: number }>;
}
export function devnetTickReader(): DevnetTickReader {
  const connection = readOnlyConnection(DEVNET_KEEPER_RPC);
  const native = new NativeVaultBuilders(connection, "devnet");
  return {
    network: native.network,
    genesis: () => connection.getGenesisHash(),
    observe: previous => readKeeperObservation(native, DEVNET_KEEPER_IDENTITY, false, previous),
    balance: async () => {
      const result = await connection.getBalanceAndContext(new PublicKey(DEVNET_KEEPER_IDENTITY.initialDeployer), "confirmed");
      return { slot: result.context.slot, lamports: result.value };
    },
  };
}

/** One leased observation/decision, not a transaction simulation or authorization.
 * Existing intents always win over starting new work. No published envelope is invented for the test basket.
 */
export async function runDevnetKeeperTick(reader: DevnetTickReader, journalPath: string, strategy?: StrategyTickInput) {
  if (reader.network !== "devnet") throw new Error("Devnet only");
  const journal = new Journal<{ observations: KeeperObservation[] }>(journalPath, () => ({ observations: [] }));
  return journal.update(async state => {
    if (await reader.genesis() !== GENESIS.devnet) throw new Error("Devnet genesis mismatch");
    const previous = state.observations.at(-1);
    const keeper = await reader.observe(previous);
    if (keeper.vault !== DEVNET_KEEPER_IDENTITY.vaultAccount) throw new Error("Wrong test vault");
    const balance = await reader.balance();
    if (!Number.isSafeInteger(balance.lamports) || balance.lamports < 0 || !Number.isSafeInteger(balance.slot) || balance.slot < 1) throw new Error("Invalid native balance observation");
    rawAmount(keeper.shareSupplyRaw);
    const conflict = keeper.intents.length > 0 || keeper.blocked.includes("CONFIG_CHANGED_REATTEST_REQUIRED");
    const strategyDecision = evaluateExecutionTestStrategyTick(strategy, DEVNET_KEEPER_IDENTITY.indexId, Date.now(), conflict);
    // A balance is not a remaining authorization, fee quote or proof a settlement transaction fits.
    // The task provides no scoped signer grant; retain the remaining original test budget unspent.
    state.observations.push(keeper);
    state.observations = state.observations.slice(-100);
    return {
      schema: "stocklana-devnet-keeper-tick-v1", mode: "dry-run", network: "devnet", rpc: DEVNET_KEEPER_RPC,
      identity: DEVNET_KEEPER_IDENTITY, keeper, strategy: strategyDecision,
      budget: { observedWallet: DEVNET_KEEPER_IDENTITY.initialDeployer, observedSlot: balance.slot,
        walletLamportsRaw: String(balance.lamports), tickSpendCapLamportsRaw: "0", spentLamportsRaw: "0",
        authorizedToSpend: false, estimatedExecutionCostLamportsRaw: null },
      signerAuthorization: false, transactions: [], broadcasts: 0, simulation: "NOT_RUN",
      blockers: [...keeper.blocked, "SCOPED_SIGNER_AUTHORIZATION_MISSING", "BOUNDED_NATIVE_EXECUTION_COST_UNVERIFIED"],
      settlement: "NOT_CERTIFIED",
    };
  });
}
