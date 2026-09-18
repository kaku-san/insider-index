import { Keypair } from "@solana/web3.js";
import { definition } from "./composition-vm.mts";
import { cycleDefinitionHash, type CyclePolicy } from "../../src/lib/index-vaults/cycle-policy.ts";
export const cycleTestOwner = Keypair.fromSeed(new Uint8Array(32).fill(30));
export const cycleTestKeeper = Keypair.fromSeed(new Uint8Array(32).fill(31));
export function cycleTestPolicy(): CyclePolicy {
  const record = { ...definition, keeper: { pubkey: cycleTestKeeper.publicKey.toBase58(), automationEnabled: true } };
  return { schema: "insiderindex-cycle-policy-v1", indexId: record.indexId, vault: record.vaultAddress!, shareMint: record.shareMint!, definitionHash: cycleDefinitionHash(record), owner: cycleTestOwner.publicKey.toBase58(), keeper: cycleTestKeeper.publicKey.toBase58(), operationId: "00000000-0000-4000-8000-000000000001", expiresAt: Date.now() + 3600000,
    approvalReference: null, feeScheduleHash: null, financialExecutionAuthorized: false, economics: { keeperSurplus: "unapproved", shareQuantization: "unapproved", residualCash: "unapproved", issuerAuthorityRiskApproved: false, nativeSettlementRiskApproved: false },
    limits: { depositUsdcRaw: "100000000", minNetSharesRaw: "1", minExitUsdcRaw: "99000000", maxOwnerSolDebitLamports: "10000000", maxKeeperSolDebitLamports: "10000000", maxBountyRaw: "0", maxRoundingLossUsdcRaw: "0", maxKeeperSurplusUsdcRaw: "0", swapSlippageBps: 50, maxSettlementDriftBps: 100, rebalanceSlippageBps: 100, perTradeSlippageBps: 50, maxComputeUnits: 1400000, maxMicroLamports: "0", quoteMaxAgeMs: 30000 } };
}
