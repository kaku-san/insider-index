import type { ConfirmedCredit, ExitConversionAdapter, PreparedStep } from "./adapter-contract.ts";
import { address, rawAmount } from "./amounts.ts";
import type { OperationStore } from "./operations.ts";

/** Trusted finalized credits are loaded from the journal, not request payloads. Aggregate per mint
 * so multiple credits cannot each consume the same wallet balance. No delegate or keeper signer.
 */
export function remainingSales(operationId: string, owner: string, credits: ConfirmedCredit[], balances: { mint: string; raw: string }[], usdcMint: string) {
  address(owner); address(usdcMint);
  if (new Set(balances.map(b => b.mint)).size !== balances.length) throw new Error("Duplicate wallet balance mint");
  const paths = new Set<string>(), ids = new Set<string>();
  const totals = new Map<string, { credited: bigint; sold: bigint; tokenProgram: string }>();
  for (const credit of credits) {
    if (credit.operationId !== operationId || credit.recipientOwner !== owner || !credit.instructionPath || !credit.signature || credit.slot < 1) throw new Error("Unattributed redemption credit");
    const path = `${credit.signature}:${credit.instructionIndex}:${credit.instructionPath}`;
    if (paths.has(path) || ids.has(credit.id)) throw new Error("Duplicate redemption credit");
    paths.add(path); ids.add(credit.id);
    const credited = rawAmount(credit.creditedRaw), sold = rawAmount(credit.soldRaw);
    if (sold > credited) throw new Error("Oversold redemption credit");
    const old = totals.get(credit.mint) ?? { credited: 0n, sold: 0n, tokenProgram: credit.tokenProgram };
    if (old.tokenProgram !== credit.tokenProgram) throw new Error("Token program mismatch");
    totals.set(credit.mint, { credited: old.credited + credited, sold: old.sold + sold, tokenProgram: old.tokenProgram });
  }
  return [...totals].map(([mint, total]) => {
    const remaining = total.credited - total.sold;
    const balance = rawAmount(balances.find(b => b.mint === mint)?.raw ?? "0");
    return { mint, tokenProgram: total.tokenProgram, remainingRaw: remaining.toString(), saleAmountRaw: (mint === usdcMint ? 0n : remaining < balance ? remaining : balance).toString(), retainedUsdcRaw: mint === usdcMint ? remaining.toString() : "0" };
  });
}
/** Optional sale construction remains disabled until exact chain attribution and Jupiter decoding
 * have recorded recovery fixtures. The existing single-trade Jupiter feature is unaffected.
 */
export class DisabledExitConversion implements ExitConversionAdapter {
  private readonly store: OperationStore;
  constructor(store: OperationStore) { this.store = store; }
  async prepareRemainingSales(input: Parameters<ExitConversionAdapter["prepareRemainingSales"]>[0]): Promise<PreparedStep> {
    const row = await this.store.get(input.operationId);
    if (row.observed.owner !== input.owner || row.observed.kind !== "withdraw") throw new Error("Wrong withdrawal owner");
    return { operationId: input.operationId, phase: row.observed.phase, requires: "wait", transactions: [], configHash: "unverified", constraints: [{ label: "Aggregate USDC minimum", value: "Not guaranteed", strength: "unverified" }], blockers: ["USDC_CONVERSION_DISABLED: exact-attribution native receipts and swap policy tests required"] };
  }
}
