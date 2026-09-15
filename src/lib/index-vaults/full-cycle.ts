import { PublicKey } from "@solana/web3.js";
import { PYTHNET_CUSTODY_PRICE_USDC_ACCOUNT, PYTHNET_CUSTODY_PRICE_WSOL_ACCOUNT } from "@symmetry-hq/sdk/dist/constants.js";
import type { Network, VaultIdentity } from "./adapter-contract.ts";
import { address, weightsValid } from "./amounts.ts";
import { HOST_ENTRY_FEE_BPS, HOST_EXIT_FEE_BPS } from "./fees.ts";
import { discloseNativeCaps } from "./native-caps.ts";
import { VAULT_RELEASE } from "./release.ts";
import { admitVaultLegs } from "./vault-legs.ts";
import type { CatalogToken } from "../venues/catalog-parse.ts";

/** Fail-closed full vault cycle. Public Invest Sign stays off until every stage has a matching receipt. */
export const CYCLE_STAGES = ["create", "zap-in", "mint", "rebalance", "zap-out"] as const;
export type CycleStage = typeof CYCLE_STAGES[number];

export const PROGRAM_CONSTANT_PYTHNET_ACCOUNTS = Object.freeze({
  wsol: PYTHNET_CUSTODY_PRICE_WSOL_ACCOUNT.toBase58(),
  usdc: PYTHNET_CUSTODY_PRICE_USDC_ACCOUNT.toBase58(),
  note: "createVaultIx remaining accounts; not vault oracles and never priced via Hermes",
});

export interface CycleReceipt {
  stage: CycleStage;
  network: Network;
  vaultAccount: string;
  shareMint: string;
  signature: string;
  slot: number;
  observedAt: string;
}
export interface CreateLeg { mint: string; targetWeightBps: number; oracleKind: string }
export interface CreateVaultPlan {
  phase: "CREATE_PREPARED" | "CREATE_RESUME";
  deployer: string;
  vault: string | null;
  mint: string | null;
  hostEntryFeeBps: typeof HOST_ENTRY_FEE_BPS;
  hostExitFeeBps: typeof HOST_EXIT_FEE_BPS;
  defaultPythWsolUsdcSlots: false;
  oneVault: true;
  legs: CreateLeg[];
  caps: ReturnType<typeof discloseNativeCaps>;
  programConstantPythnetAccounts: typeof PROGRAM_CONSTANT_PYTHNET_ACCOUNTS;
  blockers: string[];
}

const SIG = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;
const RAYDIUM_KINDS = new Set(["raydium_clmm", "raydium_cpmm"]);

export function cycleProven(receipts: readonly CycleReceipt[], identity: Pick<VaultIdentity, "network" | "vaultAccount" | "shareMint">): boolean {
  address(identity.vaultAccount); address(identity.shareMint);
  const ok = (stage: CycleStage) => receipts.some(r =>
    r.stage === stage && r.network === identity.network && r.vaultAccount === identity.vaultAccount && r.shareMint === identity.shareMint
    && SIG.test(r.signature) && Number.isInteger(r.slot) && r.slot >= 1 && Number.isFinite(Date.parse(r.observedAt)));
  return CYCLE_STAGES.every(ok);
}

/** Production flags stay false. Even a complete receipt set cannot enable Sign until release flips after proof. */
export function publicInvestSignAllowed(
  receipts: readonly CycleReceipt[],
  identity: Pick<VaultIdentity, "network" | "vaultAccount" | "shareMint">,
  release: { publicFundsEnabled: boolean; nativeUsdcExitVerified: boolean; publicInvestSign: boolean } = VAULT_RELEASE,
): boolean {
  return release.publicFundsEnabled && release.nativeUsdcExitVerified && release.publicInvestSign && cycleProven(receipts, identity);
}

export function assertCreateLegs(legs: CreateLeg[], catalog: readonly CatalogToken[]): CreateLeg[] {
  weightsValid(legs);
  discloseNativeCaps(legs.length);
  admitVaultLegs(legs.map(l => l.mint), catalog);
  for (const leg of legs) {
    address(leg.mint);
    if (leg.oracleKind === "pyth" || leg.oracleKind === "0" || !RAYDIUM_KINDS.has(leg.oracleKind)) throw new Error(`PYTH_COMPOSITION_FORBIDDEN: ${leg.mint} oracle ${leg.oracleKind}`);
  }
  return legs;
}

export function planCreateVault(input: {
  deployer: string; host: string; strategy: string; keeper: string;
  legs: CreateLeg[];
  catalog: readonly CatalogToken[];
  existingDraft?: { vault: string; mint: string };
}): CreateVaultPlan {
  const roles = [input.deployer, input.host, input.strategy, input.keeper].map(address);
  if (new Set(roles).size !== 4) throw new Error("Deployer, strategy, treasury and keeper must be separate");
  if (!PublicKey.isOnCurve(new PublicKey(roles[0]))) throw new Error("Deployer must be on-curve");
  const legs = assertCreateLegs(input.legs, input.catalog);
  const blockers = [
    "BROADCAST_DISABLED",
    "CREATE_EXECUTE_REQUIRES_OPERATOR_SIGNATURE",
    "FULL_CYCLE_RECEIPT_REQUIRED",
    "NO_DEFAULT_PYTH_WSOL_USDC_COMPOSITION",
  ];
  if (input.existingDraft) {
    const vault = address(input.existingDraft.vault), mint = address(input.existingDraft.mint);
    if (vault === mint) throw new Error("Draft vault and mint must differ");
    return {
      phase: "CREATE_RESUME", deployer: roles[0], vault, mint,
      hostEntryFeeBps: HOST_ENTRY_FEE_BPS, hostExitFeeBps: HOST_EXIT_FEE_BPS,
      defaultPythWsolUsdcSlots: false, oneVault: true, legs, caps: discloseNativeCaps(legs.length),
      programConstantPythnetAccounts: PROGRAM_CONSTANT_PYTHNET_ACCOUNTS,
      blockers: [...blockers, "CREATE_PREPARED_RESUME_ORIGINAL_ADDRESSES"],
    };
  }
  return {
    phase: "CREATE_PREPARED", deployer: roles[0], vault: null, mint: null,
    hostEntryFeeBps: HOST_ENTRY_FEE_BPS, hostExitFeeBps: HOST_EXIT_FEE_BPS,
    defaultPythWsolUsdcSlots: false, oneVault: true, legs, caps: discloseNativeCaps(legs.length),
    programConstantPythnetAccounts: PROGRAM_CONSTANT_PYTHNET_ACCOUNTS, blockers,
  };
}

export function missingCycleStages(receipts: readonly CycleReceipt[], identity: Pick<VaultIdentity, "network" | "vaultAccount" | "shareMint">): CycleStage[] {
  address(identity.vaultAccount); address(identity.shareMint);
  return CYCLE_STAGES.filter(stage => !receipts.some(r =>
    r.stage === stage && r.network === identity.network && r.vaultAccount === identity.vaultAccount && r.shareMint === identity.shareMint
    && SIG.test(r.signature) && Number.isInteger(r.slot) && r.slot >= 1 && Number.isFinite(Date.parse(r.observedAt))));
}
