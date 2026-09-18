import bs58 from "bs58";
import { assertSignedBy } from "./kaku-san-create.ts";
import type { VersionedTransactionResponse } from "@solana/web3.js";
import { getBountyVaultPda } from "@symmetry-hq/sdk/dist/instructions/pda.js";
import { hashObject, rawAmount, sha256 } from "./amounts.ts";
import { applyCreditSale } from "./cycle-accounting.ts";
import { decodeCycleReceipt } from "./cycle-receipts.ts";
import { MAINNET_USDC } from "./native-defaults.ts";
import { WSOL_MINT } from "./raydium-oracles.ts";
import type { CycleState, CyclePending } from "./cycle-store.ts";
import type { CyclePolicy } from "./cycle-policy.ts";

function add(state: CycleState, field: "ownerSolDebitLamports" | "keeperSolDebitLamports" | "keeperSurplusUsdcRaw" | "bountyFundingRaw" | "contributedUsdcRaw" | "mintedSharesRaw" | "burnedSharesRaw" | "recoveredUsdcRaw", amount: bigint) {
  if (amount < 0n) throw new Error("CYCLE_NEGATIVE_ACCOUNTING_EFFECT");
  state[field] = (rawAmount(state[field]) + amount).toString();
}
function record(state: CycleState, p: CyclePending, status: "finalized" | "failed", slot: number, debit: bigint) {
  if (!p.signature || state.receipts.some(r => r.signature === p.signature)) throw new Error("CYCLE_DUPLICATE_TERMINAL_RECEIPT");
  state.receipts.push({ signature: p.signature, messageHash: p.messageHash, action: p.action, slot, status, payer: p.payer, payerDebitLamports: debit.toString() });
  add(state, p.payer === state.owner ? "ownerSolDebitLamports" : "keeperSolDebitLamports", debit);
  state.pending = null;
}
/** Must be called under the journal lease, with metadata obtained from a FINALIZED RPC read.
 * A confirmed/pending/client-supplied signature is never an accounting event. */
export function finalizeCycleAttempt(state: CycleState, policy: CyclePolicy, transaction: VersionedTransactionResponse): void {
  const p = state.pending;
  if (!p?.signature || !p.signedTransaction) throw new Error("CYCLE_NO_LATCHED_SIGNATURE");
  const signed = assertSignedBy(p.signedTransaction, p.payer);
  if (sha256(signed.message.serialize()) !== p.messageHash || bs58.encode(signed.signatures[0]) !== p.signature) throw new Error("CYCLE_SIGNATURE_LATCH_MISMATCH");
  const message = transaction.transaction.message, meta = transaction.meta;
  if (!meta || !Number.isSafeInteger(transaction.slot) || transaction.slot < p.minSlot || transaction.transaction.signatures[0] !== p.signature || sha256(message.serialize()) !== p.messageHash || message.staticAccountKeys[0].toBase58() !== p.payer || message.header.numRequiredSignatures !== 1) throw new Error("CYCLE_FINALITY_METADATA_IDENTITY");
  if (meta.err) {
    if (!Number.isSafeInteger(meta.fee) || meta.fee < 0 || !Number.isSafeInteger(meta.preBalances[0]) || !Number.isSafeInteger(meta.postBalances[0]) || meta.preBalances[0] - meta.postBalances[0] !== meta.fee || !meta.preTokenBalances || !meta.postTokenBalances) throw new Error("CYCLE_FAILED_TRANSACTION_EFFECTS_UNPROVED");
    const normalized = (rows: NonNullable<typeof meta.preTokenBalances>) => rows.map(r => [r.accountIndex, r.mint, r.owner ?? null, r.programId ?? null, r.uiTokenAmount.amount]).sort((a, b) => Number(a[0]) - Number(b[0]));
    if (hashObject(normalized(meta.preTokenBalances)) !== hashObject(normalized(meta.postTokenBalances))) throw new Error("CYCLE_FAILED_TRANSACTION_TOKEN_EFFECT");
    record(state, p, "failed", transaction.slot, BigInt(meta.fee));
    if (rawAmount(state.ownerSolDebitLamports) > rawAmount(policy.limits.maxOwnerSolDebitLamports) || rawAmount(state.keeperSolDebitLamports) > rawAmount(policy.limits.maxKeeperSolDebitLamports)) state.recoveryRequired = "OBSERVED_FAILED_ATTEMPT_COST_ABOVE_APPROVED_BOUND";
    return;
  }
  const r = decodeCycleReceipt(transaction, { signature: p.signature, messageHash: p.messageHash, payer: p.payer, owner: state.owner, vault: state.vault, shareMint: state.shareMint, operationId: state.operationId, minSlot: p.minSlot, mints: p.mints });
  const warnings: string[] = [];
  if (r.ownerShareDelta.toString() !== p.expectedOwnerShareDelta || r.feeShareDelta.toString() !== p.expectedFeeShareDelta) warnings.push("NATIVE_SHARE_EFFECT_CHANGED_SINCE_SIMULATION");
  if (r.mintedShares - r.burnedShares !== r.ownerShareDelta + r.feeShareDelta) throw new Error("CYCLE_NATIVE_SHARE_CPI_RECONCILIATION");
  if (p.bounty) {
    const funding = rawAmount(p.bounty.fundingRaw), globalDelta = r.tokenDelta(getBountyVaultPda().toBase58(), WSOL_MINT);
    if (globalDelta < 0n || globalDelta > funding || r.tokenDelta(state.owner, WSOL_MINT) !== 0n) warnings.push("BOUNTY_FUNDING_OR_WSOL_FORM_REQUIRES_RECONCILIATION");
    add(state, "bountyFundingRaw", funding); // conservative encoded funding ceiling, NOT NAV or actual net fee
  }
  for (const m of p.mints) {
    const d = r.tokenDelta(p.payer, m.mint);
    const allowed = (p.action === "contribute" && m.mint === MAINNET_USDC && -d === rawAmount(policy.limits.depositUsdcRaw)) || (p.action === "withdraw" && m.mint === state.shareMint && -d === rawAmount(p.exactInputRaw!)) || (p.action === "convert" && m.mint === p.inputMint && -d === rawAmount(p.exactInputRaw!));
    if (d < 0n && !allowed) warnings.push(`UNEXPECTED_ACTOR_TOKEN_DEBIT:${m.mint}`);
  }
  if (p.action === "create") {
    if (state.depositGenerationSignature) throw new Error("CYCLE_NATIVE_GENERATION_ALREADY_BOUND");
    state.depositGenerationSignature = p.signature; state.phase = "investing"; state.nativeClaimsClear = false;
  } else if (p.action === "contribute") {
    const debit = -r.tokenDelta(state.owner, MAINNET_USDC);
    if (debit !== rawAmount(policy.limits.depositUsdcRaw) || state.contributedUsdcRaw !== "0") throw new Error("CYCLE_CONTRIBUTION_RECEIPT_MISMATCH");
    add(state, "contributedUsdcRaw", debit);
  } else if (p.action === "fill") {
    if (r.tokenDelta(state.keeper, MAINNET_USDC) !== 0n || !p.surplusPricesQ) throw new Error("CYCLE_FILL_RECEIPT_CREDIT_MISMATCH");
    const usdc = BigInt(p.surplusPricesQ[MAINNET_USDC]); if (usdc <= 0n) throw new Error("CYCLE_FILL_PRICE_UNAVAILABLE");
    let value = 0n;
    for (const m of p.mints) {
      if ([MAINNET_USDC, WSOL_MINT, state.shareMint].includes(m.mint)) continue;
      const d = r.tokenDelta(state.keeper, m.mint); if (d < 0n) throw new Error("CYCLE_KEEPER_INVENTORY_SPENT");
      const price = BigInt(p.surplusPricesQ[m.mint] ?? "0"); if (d > 0n && price <= 0n) throw new Error("CYCLE_FILL_PRICE_UNAVAILABLE");
      value += d * price;
    }
    add(state, "keeperSurplusUsdcRaw", (value + usdc - 1n) / usdc);
    if (rawAmount(state.keeperSurplusUsdcRaw) > rawAmount(policy.limits.maxKeeperSurplusUsdcRaw)) warnings.push("OBSERVED_KEEPER_SURPLUS_ABOVE_CLIENT_BOUND");
  } else if (p.action === "mint") {
    if (r.ownerShareDelta < 0n || r.burnedShares !== 0n) throw new Error("CYCLE_NATIVE_MINT_RECEIPT");
    add(state, "mintedSharesRaw", r.ownerShareDelta);
    if (r.ownerShareDelta < rawAmount(policy.limits.minNetSharesRaw)) warnings.push("OBSERVED_NATIVE_SHARES_BELOW_CLIENT_BOUND");
  } else if (p.action === "withdraw") {
    if (r.ownerShareDelta !== -rawAmount(p.exactInputRaw!) || r.burnedShares <= 0n || r.mintedShares !== 0n || state.exitGenerationSignature) throw new Error("CYCLE_NATIVE_BURN_RECEIPT");
    state.exitGenerationSignature = p.signature; state.phase = "exiting"; state.nativeClaimsClear = false;
    add(state, "burnedSharesRaw", -r.ownerShareDelta);
  } else if (p.action === "cancel") { state.phase = "recovering"; state.nativeClaimsClear = false; }
  else if (p.action === "claim") {
    if (!r.credits.length || !["exiting", "recovering"].includes(state.phase)) throw new Error("CYCLE_CLAIM_WITHOUT_GENERATION");
    state.credits.push(...r.credits);
    add(state, "recoveredUsdcRaw", r.tokenDelta(state.owner, MAINNET_USDC));
  } else if (p.action === "convert") {
    r.assertConversion(p.inputMint!, p.exactInputRaw!, p.minOutputRaw!);
    applyCreditSale(state.credits, state, p.inputMint!, p.exactInputRaw!);
    add(state, "recoveredUsdcRaw", r.tokenDelta(state.owner, MAINNET_USDC));
  }
  if (r.credits.length && p.action !== "claim") throw new Error("CYCLE_UNEXPECTED_NATIVE_CREDITS");
  record(state, p, "finalized", transaction.slot, r.payerNetDebitLamports);
  if (rawAmount(state.ownerSolDebitLamports) > rawAmount(policy.limits.maxOwnerSolDebitLamports) || rawAmount(state.keeperSolDebitLamports) > rawAmount(policy.limits.maxKeeperSolDebitLamports) || rawAmount(state.bountyFundingRaw) > rawAmount(policy.limits.maxBountyRaw)) warnings.push("OBSERVED_COST_ABOVE_APPROVED_BOUND");
  if (warnings.length) state.recoveryRequired = warnings.join(";");
  // Cleanup does NOT imply closure: a large native keeper set may require more batches.
  // The controller must freshly observe the native PDA absent before marking claims clear.
}
