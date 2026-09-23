import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction } from "@solana/spl-token";
import { getAta } from "@symmetry-hq/sdk/dist/instructions/pda.js";
import { redeemTokensIx } from "@symmetry-hq/sdk/dist/instructions/user/withdraw.js";
import { address, rawAmount } from "./amounts.ts";

/**
 * Staged zap-out, the inverse of zap-in.
 * Burn/claim the pro-rata bag to the owner, then sell each claimed DB leg to USDC.
 * `keep_tokens: []` is never a USDC exit: the native target planner gives every unkept
 * token a zero target, so there is no buy side and the sale list stays empty.
 * A leg Jupiter cannot sell remains stock in the owner wallet. That residual is not a
 * share refund and is not covered by keeper funds.
 */
export const EMPTY_KEEP_FORBIDDEN = "Cash out cannot use an empty keep list when the goal is USDC.";
export const ZAP_OUT_WARNING = "Shares burn when you sign. We claim the basket to your wallet, then try to sell each name to USDC. If a sale cannot be made, leftover stocks and USDC stay in your wallet. This is not a share refund. No keeper funds this sale.";
export const ZAP_OUT_STAGES = ["burn", "claim", "sell"] as const;
export const CLAIM_BATCH = 5;

export type ExitLeg = { mint: string; ticker: string; targetWeightBps: number };
export type ZapOutClaim = { mint: string; ticker: string | null; amountRaw: string };
export type ZapOutResidual = { mint: string; ticker: string | null; amountRaw: string; reason: "unquoted" | "unsupported" | "not-a-db-leg" | "jupiter-unavailable" };
export type ZapOutSell = { mint: string; ticker: string | null; amountRaw: string; minOutRaw: string };
export type ZapOutPlan = {
  kind: "zap-out";
  indexId: string;
  legCount: number;
  legs: ExitLeg[];
  packaging: "staged";
  atomic: false;
  stages: typeof ZAP_OUT_STAGES;
  /** All allocated slots are kept so the owner can claim the bag. Not an empty auction mask. */
  keep: "all-allocated";
  keepTokensEmptyForbidden: true;
  keeperSubsidyRaw: "0";
  userFundsOnly: true;
  claims: ZapOutClaim[];
  sells: ZapOutSell[];
  residuals: ZapOutResidual[];
  warning: string;
};

/** USDC-auction selection, if that path is used. Never `[]`. */
export function usdcAuctionKeepTokens(usdcMint: string): [string] {
  return [address(usdcMint)];
}

/** Empty keep encodes no USDC buy target. Refuse it whenever the goal is USDC. */
export function assertKeepSelectionForUsdcGoal(keepTokens: readonly string[]): void {
  if (keepTokens.length === 0) throw new Error(EMPTY_KEEP_FORBIDDEN);
  keepTokens.forEach(address);
}

export function exitLegsFromDefinition(legs: readonly { mint: string; ticker: string; targetWeightBps: number }[]): ExitLeg[] {
  const seen = new Set<string>();
  return legs.map(leg => {
    const mint = address(leg.mint);
    if (seen.has(mint) || typeof leg.ticker !== "string" || !leg.ticker.trim() || !Number.isInteger(leg.targetWeightBps) || leg.targetWeightBps < 0 || leg.targetWeightBps > 10_000) {
      throw new Error("Cash out is not available for this vault.");
    }
    seen.add(mint);
    return { mint, ticker: leg.ticker, targetWeightBps: leg.targetWeightBps };
  });
}

/** Integer pro-rata. Weights are not liquidation sizes. */
export function proRataClaimRaw(balanceRaw: string, sharesRaw: string, supplyRaw: string): string {
  const balance = rawAmount(balanceRaw);
  const shares = rawAmount(sharesRaw, true);
  const supply = rawAmount(supplyRaw, true);
  if (shares > supply) throw new Error("Share amount exceeds the vault supply.");
  return ((balance * shares) / supply).toString();
}

export function planZapOut(input: {
  indexId: string;
  usdcMint: string;
  legs: readonly ExitLeg[];
  claims: readonly { mint: string; amountRaw: string }[];
  /** Null before a Jupiter build exists. A missing quote is a residual, not a thrown exit. */
  quotes?: readonly { mint: string; amountRaw: string; minOutRaw: string }[] | null;
  unsupportedMints?: readonly string[];
}): ZapOutPlan {
  const usdcMint = address(input.usdcMint);
  const legs = exitLegsFromDefinition(input.legs);
  const byLeg = new Map(legs.map(leg => [leg.mint, leg]));
  const quotes = new Map<string, { amountRaw: string; minOutRaw: string }>();
  for (const quote of input.quotes ?? []) {
    if (quotes.has(quote.mint)) throw new Error("Cash out is not available for this vault.");
    quotes.set(address(quote.mint), { amountRaw: rawAmount(quote.amountRaw, true).toString(), minOutRaw: rawAmount(quote.minOutRaw, true).toString() });
  }
  const unsupported = new Set((input.unsupportedMints ?? []).map(address));
  const seen = new Set<string>();
  const claims: ZapOutClaim[] = [];
  const sells: ZapOutSell[] = [];
  const residuals: ZapOutResidual[] = [];
  for (const claim of input.claims) {
    const mint = address(claim.mint);
    const amountRaw = rawAmount(claim.amountRaw).toString();
    if (seen.has(mint)) throw new Error("Cash out is not available for this vault.");
    seen.add(mint);
    if (amountRaw === "0") continue;
    const leg = byLeg.get(mint) ?? null;
    claims.push({ mint, ticker: leg?.ticker ?? null, amountRaw });
    if (mint === usdcMint) continue;
    if (!leg) {
      residuals.push({ mint, ticker: null, amountRaw, reason: "not-a-db-leg" });
      continue;
    }
    if (unsupported.has(mint)) {
      residuals.push({ mint, ticker: leg.ticker, amountRaw, reason: "unsupported" });
      continue;
    }
    const quote = input.quotes == null ? null : quotes.get(mint);
    if (!quote || quote.amountRaw !== amountRaw) {
      residuals.push({ mint, ticker: leg.ticker, amountRaw, reason: input.quotes == null ? "unquoted" : "jupiter-unavailable" });
      continue;
    }
    sells.push({ mint, ticker: leg.ticker, amountRaw, minOutRaw: quote.minOutRaw });
  }
  return {
    kind: "zap-out",
    indexId: input.indexId,
    legCount: legs.length,
    legs,
    packaging: "staged",
    atomic: false,
    stages: ZAP_OUT_STAGES,
    keep: "all-allocated",
    keepTokensEmptyForbidden: true,
    keeperSubsidyRaw: "0",
    userFundsOnly: true,
    claims,
    sells,
    residuals,
    warning: ZAP_OUT_WARNING,
  };
}

/** Owner signs the claim. The keeper is not the payer and does not receive the bag. */
export function ownerClaimInstructions(input: {
  owner: string;
  vault: string;
  claims: readonly { mint: string; tokenProgram: string }[];
}): TransactionInstruction[] {
  const owner = new PublicKey(address(input.owner));
  const vault = new PublicKey(address(input.vault));
  const batch = input.claims.slice(0, CLAIM_BATCH);
  if (!batch.length) throw new Error("Cash out has nothing left to claim.");
  const instructions = batch.map(claim => {
    const mint = new PublicKey(address(claim.mint));
    const program = new PublicKey(address(claim.tokenProgram));
    const ata = getAta(owner, mint, program);
    return createAssociatedTokenAccountIdempotentInstruction(owner, ata, owner, mint, program);
  });
  instructions.push(redeemTokensIx({
    keeper: owner,
    owner,
    vault,
    tokenMints: batch.map(claim => new PublicKey(claim.mint)),
    tokenPrograms: batch.map(claim => new PublicKey(claim.tokenProgram)),
  }));
  if (instructions.some(ix => ix.keys.some(key => key.isSigner && !key.pubkey.equals(owner)))) throw new Error("Cash out claim asks for another signer.");
  return instructions;
}

export type TokenBalanceRow = { mint: string; owner?: string | null; amountRaw: string };

/** Positive owner deltas from a finalized claim. Not the whole wallet, and not a failed transaction. */
export function claimDeltas(input: {
  owner: string;
  vault: string;
  intent: string;
  feePayer: string;
  accountKeys: readonly string[];
  failed: boolean;
  pre: readonly TokenBalanceRow[];
  post: readonly TokenBalanceRow[];
}): { mint: string; amountRaw: string }[] {
  const owner = address(input.owner);
  if (input.failed) throw new Error("The claim transaction failed.");
  if (input.feePayer !== owner) throw new Error("The claim was not signed by this wallet.");
  if (!input.accountKeys.includes(address(input.vault)) || !input.accountKeys.includes(address(input.intent))) throw new Error("The claim is not for this vault.");
  const before = new Map<string, bigint>();
  const after = new Map<string, bigint>();
  for (const row of input.pre) if (row.owner === owner) {
    const mint = address(row.mint);
    before.set(mint, (before.get(mint) ?? 0n) + rawAmount(row.amountRaw));
  }
  for (const row of input.post) if (row.owner === owner) {
    const mint = address(row.mint);
    after.set(mint, (after.get(mint) ?? 0n) + rawAmount(row.amountRaw));
  }
  const deltas: { mint: string; amountRaw: string }[] = [];
  for (const mint of new Set([...before.keys(), ...after.keys()])) {
    const delta = (after.get(mint) ?? 0n) - (before.get(mint) ?? 0n);
    if (delta > 0n) deltas.push({ mint, amountRaw: delta.toString() });
  }
  return deltas;
}
