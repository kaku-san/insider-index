/** Observed deposit/cash-out status. Callers render these words only — never a percent or invented step. */

export const SETTLEMENT_STATUSES = ["pending", "filling", "shares received", "cash out settling", "failed"] as const;
export type SettlementStatus = (typeof SETTLEMENT_STATUSES)[number];

/** How often a waiting screen re-reads position. Not a progress animation. */
export const SETTLEMENT_POLL_MS = 5_000;
/** Deposit backstop only. A cash-out is not marked failed because this elapsed. */
export const SETTLEMENT_POLL_TIMEOUT_MS = 5 * 60_000;

const FILLING_PHASES = new Set(["AUCTION", "SETTLING", "CLEANUP"]);

export type SettlementOperation = {
  kind: string;
  phase: string;
  complete?: boolean;
  blockers?: string[];
};

export type SettlementPosition = {
  sharesRaw: string;
  pendingOperations?: SettlementOperation[];
};

export type SettlementView = {
  status: SettlementStatus;
  /** Keep reading position/pending. False once the read is terminal. */
  listening: boolean;
  /** Pending cash-out cleared, or the share balance is gone. Not a sixth status. */
  cashOutFinished: boolean;
};

function rawShares(value: string | undefined): bigint | null {
  if (!value || !/^(0|[1-9]\d*)$/.test(value)) return null;
  try { return BigInt(value); } catch { return null; }
}

/** A wallet's prior dust is not a receipt for this signature. */
export function sharesIncreasedAfterSignature(beforeRaw: string, position?: { sharesRaw: string } | null): boolean {
  const before = rawShares(beforeRaw);
  const after = rawShares(position?.sharesRaw);
  return before !== null && after !== null && after > before;
}

export function sharesDecreasedAfterSignature(beforeRaw: string, position?: { sharesRaw: string } | null): boolean {
  const before = rawShares(beforeRaw);
  const after = rawShares(position?.sharesRaw);
  return before !== null && after !== null && after < before;
}

function incomplete(position: SettlementPosition | null | undefined, kind: string): SettlementOperation | null {
  return position?.pendingOperations?.find(operation => operation.kind === kind && operation.complete !== true) ?? null;
}

export function positionNeedsListen(position?: { pendingOperations?: SettlementOperation[] } | null): boolean {
  return Boolean(position?.pendingOperations?.some(operation => operation.complete !== true && operation.phase !== "FAILED"));
}

export function positionsNeedListen(positions: readonly { pendingOperations?: SettlementOperation[] }[]): boolean {
  return positions.some(position => positionNeedsListen(position));
}

/** Map one pending operation to a plain status. Pricing is not a fill. */
export function plainStatusForOperation(operation: Pick<SettlementOperation, "kind" | "phase">): SettlementStatus {
  if (operation.phase === "FAILED") return "failed";
  if (operation.kind === "withdraw") return "cash out settling";
  if (FILLING_PHASES.has(operation.phase)) return "filling";
  return "pending";
}

export function noticedShareArrival(before?: SettlementPosition | null, after?: SettlementPosition | null): boolean {
  const liveDeposit = before?.pendingOperations?.some(operation => operation.kind === "deposit" && operation.complete !== true && operation.phase !== "FAILED");
  if (!liveDeposit || !before) return false;
  return sharesIncreasedAfterSignature(before.sharesRaw, after)
    && !after?.pendingOperations?.some(operation => operation.kind === "deposit" && operation.complete !== true);
}

export function settlementView(input: {
  mode: "deposit" | "withdraw";
  sharesBeforeRaw: string;
  position: SettlementPosition | null;
  timedOut?: boolean;
  sawWithdrawPending?: boolean;
}): SettlementView {
  const depositPending = incomplete(input.position, "deposit");
  const withdrawPending = incomplete(input.position, "withdraw");
  if (input.mode === "deposit") {
    if (sharesIncreasedAfterSignature(input.sharesBeforeRaw, input.position)) return { status: "shares received", listening: false, cashOutFinished: false };
    if (depositPending?.phase === "FAILED" || input.timedOut) return { status: "failed", listening: false, cashOutFinished: false };
    if (depositPending && FILLING_PHASES.has(depositPending.phase)) return { status: "filling", listening: true, cashOutFinished: false };
    return { status: "pending", listening: true, cashOutFinished: false };
  }
  if (withdrawPending?.phase === "FAILED") return { status: "failed", listening: false, cashOutFinished: false };
  if (withdrawPending) return { status: "cash out settling", listening: true, cashOutFinished: false };
  const before = rawShares(input.sharesBeforeRaw);
  const cleared = Boolean(input.position && input.position.sharesRaw === "0" && before !== null && before > 0n);
  if (input.position && (input.sawWithdrawPending || cleared) && !sharesIncreasedAfterSignature(input.sharesBeforeRaw, input.position)) {
    return { status: "cash out settling", listening: false, cashOutFinished: true };
  }
  if (sharesDecreasedAfterSignature(input.sharesBeforeRaw, input.position)) return { status: "cash out settling", listening: true, cashOutFinished: false };
  if (input.timedOut && !input.sawWithdrawPending) return { status: "failed", listening: false, cashOutFinished: false };
  return { status: "pending", listening: true, cashOutFinished: false };
}

export function settlementDetail(view: SettlementView, position: SettlementPosition | null, mode: "deposit" | "withdraw"): string {
  if (view.cashOutFinished) return "Your share balance updated.";
  if (view.status === "shares received") return "Your share balance increased after this signature.";
  if (view.status === "filling") return "The auction is filling. Shares are not in yet.";
  if (view.status === "cash out settling") return "Cash out is settling. This updates when it finishes or fails.";
  if (view.status === "failed") {
    const blocker = incomplete(position, mode)?.blockers?.find(line => line.trim());
    return blocker ?? "Stopped waiting. The position has not shown a finished result.";
  }
  return mode === "withdraw" ? "Signed. Waiting for the cash out to show on your position." : "Signed. Waiting for the position to change.";
}
