import type { Vault, UIRebalanceIntent } from "@symmetry-hq/sdk";
import { RebalanceType } from "@symmetry-hq/sdk/dist/layouts/intents/rebalanceIntent.js";
import { rawAmount } from "./amounts.ts";
import { MAINNET_USDC } from "./native-defaults.ts";
import { WSOL_MINT } from "./raydium-oracles.ts";

export const fractionRaw = (value: { high: { toString(): string }; low: { toString(): string } }) => (BigInt(value.high.toString()) << 64n) + BigInt(value.low.toString());
const ceilDiv = (n: bigint, d: bigint) => { if (d <= 0n || n < 0n) throw new Error("CYCLE_INVALID_RATIONAL"); return (n + d - 1n) / d; };
export function cycleMintRounding(input: { beforeSupply: string; grossMinted: string; beforeValueQ: bigint; contributedValueQ: bigint; usdcPriceQ: bigint }) {
  const supply = rawAmount(input.beforeSupply), minted = rawAmount(input.grossMinted, true);
  if (input.beforeValueQ < 0n || input.contributedValueQ <= 0n || input.usdcPriceQ <= 0n || (supply === 0n) !== (input.beforeValueQ === 0n)) throw new Error("CYCLE_UNPRICED_OR_UNOWNED_BACKING");
  // Compare actual post-mint ownership, NOT the creation-time nominal share price. A bootstrap
  // raw-share floor is not lost backing: the first gross shares own all contributed assets.
  const numerator = input.contributedValueQ * supply - input.beforeValueQ * minted;
  const denominator = (supply + minted) * input.usdcPriceQ;
  return { lossUsdcRaw: numerator > 0n ? ceilDiv(numerator, denominator).toString() : "0",
    existingHolderDilutionUsdcRaw: numerator < 0n ? ceilDiv(-numerator, denominator).toString() : "0", grossMintedRaw: minted.toString() };
}
export function assertMintEffects(input: {
  beforeSupply: string; afterSupply: string; beforeOutstanding: string; afterOutstanding: string;
  ownerShareDelta: string; feeShareDelta: string; feeAccrualDelta: string; minNetSharesRaw: string;
  beforeValueQ: bigint; contributedValueQ: bigint; usdcPriceQ: bigint; maxRoundingLossUsdcRaw: string;
}) {
  const gross = rawAmount(input.afterSupply) - rawAmount(input.beforeSupply);
  if (gross <= 0n || rawAmount(input.afterOutstanding) - rawAmount(input.beforeOutstanding) !== gross || input.afterSupply !== input.afterOutstanding || input.beforeSupply !== input.beforeOutstanding) throw new Error("CYCLE_SHARE_SUPPLY_DIVERGENCE");
  const net = rawAmount(input.ownerShareDelta), fees = rawAmount(input.feeShareDelta);
  if (net < rawAmount(input.minNetSharesRaw, true) || net + fees !== gross || fees !== rawAmount(input.feeAccrualDelta)) throw new Error("CYCLE_MINT_OR_FEE_RECONCILIATION");
  const rounding = cycleMintRounding({ ...input, grossMinted: gross.toString() });
  if (rawAmount(rounding.lossUsdcRaw) > rawAmount(input.maxRoundingLossUsdcRaw) || rawAmount(rounding.existingHolderDilutionUsdcRaw) > rawAmount(input.maxRoundingLossUsdcRaw)) throw new Error("CYCLE_UNSAFE_SHARE_ROUNDING");
  return { ...rounding, netSharesRaw: net.toString(), feeSharesRaw: fees.toString() };
}

/** Native accounting buckets versus ALL actual vault-owned token balances. Vault-rebalance
 * intents describe existing backing, unlike separate investor contribution/withdrawal credits.
 * Unknown/residual assets never vanish because their target weight is zero. */
export function assertCycleBacking(vault: Vault, intents: readonly UIRebalanceIntent[], actual: ReadonlyMap<string, bigint>): void {
  const composition = vault.composition.slice(0, vault.numTokens);
  const expected = new Map(composition.map(t => [t.mint.toBase58(), BigInt(t.amount.toString())]));
  if (expected.size !== composition.length) throw new Error("CYCLE_DUPLICATE_NATIVE_SLOT");
  const seen = new Set<string>();
  for (const intent of intents) {
    const i = intent.chain_data;
    if (!i.ownAddress || seen.has(i.ownAddress.toBase58())) throw new Error("CYCLE_DUPLICATE_OR_UNBOUND_INTENT");
    seen.add(i.ownAddress.toBase58());
    if (i.vault.toBase58() !== vault.ownAddress.toBase58()) throw new Error("CYCLE_FOREIGN_INTENT");
    if (i.rebalanceType !== RebalanceType.Deposit && i.rebalanceType !== RebalanceType.Withdraw) continue;
    for (const token of i.tokens) if (!token.mint.equals(vault.mint) && !token.amount.isZero()) expected.set(token.mint.toBase58(), (expected.get(token.mint.toBase58()) ?? 0n) + BigInt(token.amount.toString()));
  }
  // Native addBounty transfers to the global bounty PDA, NOT this vault's token account.
  // Its counter is never added to index NAV. Actual support tokens still reconcile like any
  // other asset, even when their target is zero; an unsynced or unattributed balance blocks.
  if ((actual.get(WSOL_MINT) ?? 0n) !== (expected.get(WSOL_MINT) ?? 0n)) throw new Error("CYCLE_SUPPORT_BOUNTY_RECONCILIATION_REQUIRED");
  for (const mint of new Set([...expected.keys(), ...actual.keys()])) if ((expected.get(mint) ?? 0n) !== (actual.get(mint) ?? 0n)) throw new Error(`CYCLE_UNRECONCILED_BACKING:${mint}`);
}
export interface CycleCredit {
  mint: string; tokenProgram: string; receivedRaw: string; soldRaw: string; operationId: string;
  owner: string; vault: string; signature: string; instructionIndex: number;
}
export function attributeCycleClaim(input: { owner: string; vault: string; operationId: string; signature: string; instructionIndex: number;
  beforeClaim: ReadonlyMap<string, bigint>; afterClaim: ReadonlyMap<string, bigint>;
  beforeWallet: ReadonlyMap<string, bigint>; afterWallet: ReadonlyMap<string, bigint>; programs: ReadonlyMap<string, string>;
}): CycleCredit[] {
  const credits: CycleCredit[] = [];
  for (const mint of new Set([...input.beforeClaim.keys(), ...input.afterClaim.keys(), ...input.beforeWallet.keys(), ...input.afterWallet.keys()])) {
    const debited = (input.beforeClaim.get(mint) ?? 0n) - (input.afterClaim.get(mint) ?? 0n);
    const received = (input.afterWallet.get(mint) ?? 0n) - (input.beforeWallet.get(mint) ?? 0n);
    if (debited < 0n || received !== debited) throw new Error("CYCLE_CLAIM_ATTRIBUTION_MISMATCH");
    if (!debited) continue;
    const tokenProgram = input.programs.get(mint); if (!tokenProgram) throw new Error("CYCLE_CLAIM_TOKEN_PROGRAM");
    credits.push({ mint, tokenProgram, receivedRaw: received.toString(), soldRaw: "0", operationId: input.operationId, owner: input.owner, vault: input.vault, signature: input.signature, instructionIndex: input.instructionIndex });
  }
  return credits;
}
export function creditSaleAmount(credits: readonly CycleCredit[], binding: { vault: string; owner: string; operationId: string }, mint: string): bigint {
  let remaining = 0n; const seen = new Set<string>();
  for (const c of credits) {
    if (c.owner !== binding.owner || c.vault !== binding.vault || c.operationId !== binding.operationId) throw new Error("CYCLE_FOREIGN_CREDIT");
    const id = `${c.signature}:${c.instructionIndex}:${c.mint}`;
    if (!c.signature || !Number.isSafeInteger(c.instructionIndex) || c.instructionIndex < 0 || seen.has(id)) throw new Error("CYCLE_DUPLICATE_OR_UNBOUND_CREDIT");
    seen.add(id);
    const available = rawAmount(c.receivedRaw) - rawAmount(c.soldRaw);
    if (available < 0n) throw new Error("CYCLE_CREDIT_OVERSOLD");
    if (c.mint === mint && mint !== MAINNET_USDC) remaining += available;
  }
  return remaining;
}
export function applyCreditSale(credits: CycleCredit[], binding: { vault: string; owner: string; operationId: string }, mint: string, exactDebit: string): void {
  let debit = rawAmount(exactDebit, true);
  if (debit > creditSaleAmount(credits, binding, mint)) throw new Error("CYCLE_SALE_EXCEEDS_CREDITS");
  for (const c of credits.filter(c => c.mint === mint)) {
    const remaining = rawAmount(c.receivedRaw) - rawAmount(c.soldRaw), used = remaining < debit ? remaining : debit;
    c.soldRaw = (rawAmount(c.soldRaw) + used).toString(); debit -= used;
  }
}
